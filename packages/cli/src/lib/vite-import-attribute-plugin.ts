import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PackagedSkillDirectory, PackagedSkillFile, SkillReference } from '@flue/runtime';
import { parseSkillMarkdown } from '@flue/runtime/internal';
import { normalizePath, type Plugin, transformWithOxc } from 'vite';

const MARKDOWN_MODULE_PREFIX = '\0flue-markdown:';
const PACKAGED_SKILLS_MODULE_ID = 'virtual:flue/packaged-skills';
const RESOLVED_PACKAGED_SKILLS_MODULE_ID = '\0virtual:flue/packaged-skills';
const SKILL_MODULE_PREFIX = '\0flue-skill:';
const ENCODED_SKILL_MODULE_PREFIX = '__x00__flue-skill:';
const PACKAGED_FILE_WARNING_BYTES = 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
	'.git',
	'.cache',
	'.turbo',
	'.wrangler',
	'dist',
	'node_modules',
]);
const SENSITIVE_DIRECTORIES = new Set(['.aws', '.gnupg', '.ssh']);
const EXCLUDED_FILES = new Set(['.netrc', '.npmrc', '.pypirc', '_netrc', 'credentials.json']);
const SENSITIVE_FILE_PATTERNS = [/\.key$/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /^secrets?(?:\.|$)/i];

export interface ImportAttributePluginOptions {
	bootstrapEntries?: readonly string[];
	trustedVirtualBootstrapIds?: readonly string[];
}

/**
 * Handles Flue's attributed imports — `with { type: 'markdown' }` and
 * `with { type: 'skill' }` — in one plugin so each module in the graph is
 * type-stripped and parsed once per (re)build, and so the two attribute
 * types cannot drift apart.
 */
export function importAttributePlugin(options: ImportAttributePluginOptions): Plugin {
	let viteRoot = '';
	const bootstrapEntries = new Set(
		(options.bootstrapEntries ?? []).map((entry) => canonicalPath(path.resolve(entry))),
	);
	const trustedVirtualBootstrapIds = new Set(options.trustedVirtualBootstrapIds ?? []);
	const internalModuleToken = randomUUID();
	const internalSkillModulePrefix = `${SKILL_MODULE_PREFIX}${internalModuleToken}:`;
	const encodedInternalSkillModulePrefix = `__x00__flue-skill:${internalModuleToken}:`;
	const trackedSkillDirectories = new Set<string>();

	return {
		name: 'flue-import-attributes',
		enforce: 'pre',
		configResolved(config) {
			viteRoot = config.root;
		},
		async transform(code, id) {
			if (!/\.[cm]?[jt]sx?(?:\?|$)/i.test(id)) return null;
			const importerPath = id.split('?')[0] ?? id;
			const parseableCode = /\.[cm]?tsx?(?:\?|$)/i.test(id)
				? (await transformWithOxc(code, importerPath, {})).code
				: code;
			const ast = this.parse(parseableCode) as unknown as ModuleAst;
			assertNoDynamicSkillImports(ast);
			const markdownImports = collectAttributedImports(ast, 'markdown');
			const skillImports = collectAttributedImports(ast, 'skill');
			if (markdownImports.length === 0 && skillImports.length === 0) return null;
			const replacements: Array<AttributedImport & { moduleId: string }> = [];
			for (const declaration of markdownImports) {
				if (isSkillMarkdownPath(declaration.specifier)) {
					throw new Error(
						`[flue] SKILL.md imports must use an import attribute: with { type: 'skill' }.`,
					);
				}
				if (!/\.md$/i.test(declaration.specifier)) {
					throw new Error(
						`[flue] Markdown imports must target a .md file: ${declaration.specifier}`,
					);
				}
				const rootRelativePath = declaration.specifier.startsWith('/')
					? path.resolve(viteRoot, declaration.specifier.slice(1))
					: undefined;
				const resolved = rootRelativePath
					? { id: rootRelativePath, external: false }
					: await this.resolve(declaration.specifier, importerPath, { skipSelf: true });
				if (!resolved || resolved.external) {
					throw new Error(`[flue] Unable to resolve markdown import: ${declaration.specifier}`);
				}
				if (isSkillMarkdownPath(resolved.id)) {
					throw new Error(
						`[flue] SKILL.md imports must use an import attribute: with { type: 'skill' }.`,
					);
				}
				replacements.push({ ...declaration, moduleId: `${MARKDOWN_MODULE_PREFIX}${resolved.id}` });
			}
			for (const declaration of skillImports) {
				if (!isSkillMarkdownPath(declaration.specifier)) {
					throw new Error(
						`[flue] Skill imports must target a SKILL.md file: ${declaration.specifier}`,
					);
				}
				const resolved = await this.resolve(declaration.specifier, importerPath, {
					skipSelf: true,
				});
				if (!resolved || resolved.external) {
					throw new Error(`[flue] Unable to resolve skill import: ${declaration.specifier}`);
				}
				const filesystemPath = stripQueryAndHash(resolved.id);
				if (!path.isAbsolute(filesystemPath)) {
					throw new Error(
						`[flue] Skill imports must resolve to a filesystem path: ${declaration.specifier}`,
					);
				}
				const resolvedPath = canonicalPath(filesystemPath);
				if (!isSkillMarkdownPath(resolvedPath)) {
					throw new Error(
						`[flue] Skill imports must resolve to a SKILL.md file: ${declaration.specifier}`,
					);
				}
				replacements.push({
					...declaration,
					moduleId: `${internalSkillModulePrefix}${resolvedPath}`,
				});
			}
			let transformed = parseableCode;
			for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
				transformed = `${transformed.slice(0, replacement.start)}${JSON.stringify(replacement.moduleId)}${transformed.slice(replacement.end)}`;
			}
			return { code: transformed, map: null };
		},
		resolveId(source, importer) {
			if (source.startsWith(MARKDOWN_MODULE_PREFIX)) return source;
			if (source === PACKAGED_SKILLS_MODULE_ID) {
				if (!isAuthorizedPackagedStoreImporter(importer, bootstrapEntries, trustedVirtualBootstrapIds)) {
					throw new Error(
						"[flue] Packaged skill contents are runtime-owned and cannot be imported from application modules. Import SKILL.md with { type: 'skill' }.",
					);
				}
				return RESOLVED_PACKAGED_SKILLS_MODULE_ID;
			}
			const internalModuleId = decodeSkillModuleId(
				source,
				internalSkillModulePrefix,
				encodedInternalSkillModulePrefix,
			);
			if (internalModuleId) return internalModuleId;
			if (source.startsWith(SKILL_MODULE_PREFIX) || source.includes(ENCODED_SKILL_MODULE_PREFIX)) {
				throw new Error(
					"[flue] Internal packaged-skill module IDs cannot be imported directly. Use a static SKILL.md import with { type: 'skill' }.",
				);
			}
			if (!importer) return null;
			if (isSkillMarkdownPath(source)) {
				throw new Error(
					`[flue] Markdown import "${source}" must use an import attribute: with { type: 'skill' }.`,
				);
			}
			return null;
		},
		hotUpdate(options) {
			const changedPath = canonicalPath(options.file);

			const directory = [...trackedSkillDirectories].find((trackedDirectory) =>
				isWithinDirectory(changedPath, trackedDirectory),
			);
			if (directory) {
				const skillPath = `${directory}/SKILL.md`;
				const modules = [
					this.environment.moduleGraph.getModuleById(`${internalSkillModulePrefix}${skillPath}`),
				].filter((module) => module !== undefined);
				for (const module of modules) this.environment.moduleGraph.invalidateModule(module);
				return modules;
			}
			if (!/\.[cm]?[jt]sx?$/i.test(changedPath)) return;
			const registry = this.environment.moduleGraph.getModuleById(
				RESOLVED_PACKAGED_SKILLS_MODULE_ID,
			);
			if (!registry) return;
			this.environment.moduleGraph.invalidateModule(registry);
			return [registry, ...options.modules];
		},
		async load(id) {
			if (id.startsWith(MARKDOWN_MODULE_PREFIX)) {
				const markdownPath = id.slice(MARKDOWN_MODULE_PREFIX.length);
				this.addWatchFile(markdownPath);
				return `export default ${JSON.stringify(await fs.promises.readFile(markdownPath, 'utf8'))};`;
			}
			if (id === RESOLVED_PACKAGED_SKILLS_MODULE_ID) {
				return [
					'const packagedSkills = new Map();',
					'export function registerPackagedSkill(skill) { packagedSkills.set(skill.id, skill); }',
					'export function unregisterPackagedSkill(skill) { if (packagedSkills.get(skill.id) === skill) packagedSkills.delete(skill.id); }',
					'export function getPackagedSkills() { return Object.fromEntries(packagedSkills); }',
				].join('\n');
			}
			if (!id.startsWith(internalSkillModulePrefix)) return null;
			const skillPath = id.slice(internalSkillModulePrefix.length);
			const directory = path.dirname(skillPath);
			trackedSkillDirectories.add(canonicalPath(directory));
			const packagedSkill = await packageSkill(skillPath);
			const reference: SkillReference = {
				__flueSkillReference: true,
				id: packagedSkill.id,
				name: packagedSkill.name,
				description: packagedSkill.description,
			};
			return [
				`import { registerPackagedSkill, unregisterPackagedSkill } from ${JSON.stringify(PACKAGED_SKILLS_MODULE_ID)};`,
				`const directory = ${JSON.stringify(packagedSkill)};`,
				'registerPackagedSkill(directory);',
				'if (import.meta.hot) import.meta.hot.dispose(() => unregisterPackagedSkill(directory));',
				`const reference = ${JSON.stringify(reference)};`,
				'export default reference;',
			].join('\n');
		},
	};
}

async function packageSkill(skillPath: string): Promise<PackagedSkillDirectory> {
	const directory = path.dirname(skillPath);
	const parsed = parseSkillMarkdown(await fs.promises.readFile(skillPath, 'utf8'), {
		directoryName: path.basename(directory),
		path: skillPath,
	});
	const files: Record<string, PackagedSkillFile> = {};
	const hash = createHash('sha256');
	for (const filePath of await collectFiles(directory)) {
		const relativePath = normalizePath(path.relative(directory, filePath));
		const content = await fs.promises.readFile(filePath);
		if (content.byteLength > PACKAGED_FILE_WARNING_BYTES) {
			console.warn(
				`[flue] Skill file "${filePath}" exceeds 1MB and will be packaged into the deployed application for lazy access.`,
			);
		}
		const pathBuffer = Buffer.from(relativePath);
		const lengths = Buffer.allocUnsafe(8);
		lengths.writeUInt32BE(pathBuffer.byteLength, 0);
		lengths.writeUInt32BE(content.byteLength, 4);
		hash.update(lengths);
		hash.update(pathBuffer);
		hash.update(content);
		files[relativePath] = {
			encoding: 'base64',
			kind: isTextContent(content) ? 'text' : 'binary',
			content: content.toString('base64'),
		};
	}
	return {
		id: `skill:${parsed.name}:${hash.digest('hex').slice(0, 16)}`,
		name: parsed.name,
		description: parsed.description,
		files,
	};
}

function canonicalPath(filePath: string): string {
	let unresolvedPath = filePath;
	const suffixes: string[] = [];
	while (!fs.existsSync(unresolvedPath)) {
		const parentPath = path.dirname(unresolvedPath);
		if (parentPath === unresolvedPath) return normalizePath(filePath);
		suffixes.unshift(path.basename(unresolvedPath));
		unresolvedPath = parentPath;
	}
	return normalizePath(path.join(fs.realpathSync.native(unresolvedPath), ...suffixes));
}

function isWithinDirectory(filePath: string, directory: string): boolean {
	return filePath === directory || filePath.startsWith(`${directory}/`);
}

async function collectFiles(directory: string, skillRoot = directory): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
		const absolutePath = path.join(directory, entry.name);
		const relativePath = normalizePath(path.relative(skillRoot, absolutePath));
		if (entry.isSymbolicLink()) {
			throw new Error(
				`[flue] Skill directory "${skillRoot}" contains symbolic link "${relativePath}", which cannot be packaged. Replace it with a regular file or directory.`,
			);
		}
		if (entry.isDirectory()) {
			if (EXCLUDED_DIRECTORIES.has(entry.name)) {
				console.warn(
					`[flue] Excluding skill directory "${relativePath}" from the deployed application package because it is generated or repository metadata.`,
				);
				continue;
			}
			if (SENSITIVE_DIRECTORIES.has(entry.name.toLowerCase())) {
				throw new Error(
					`[flue] Imported skill directory "${skillRoot}" contains sensitive directory "${relativePath}", which cannot be packaged. Remove credentials and private keys from the skill directory.`,
				);
			}
			files.push(...(await collectFiles(absolutePath, skillRoot)));
		} else if (entry.isFile()) {
			if (isSensitiveFile(entry.name)) {
				throw new Error(
					`[flue] Imported skill directory "${skillRoot}" contains sensitive file "${relativePath}", which cannot be packaged. Remove credentials and private keys from the skill directory.`,
				);
			}
			if (isExcludedFile(entry.name)) {
				console.warn(
					`[flue] Excluding skill file "${relativePath}" from the deployed application package because it is generated content.`,
				);
				continue;
			}
			files.push(absolutePath);
		}
	}
	return files.sort();
}

function isSensitiveFile(filename: string): boolean {
	const lowerFilename = filename.toLowerCase();
	return (
		EXCLUDED_FILES.has(lowerFilename) ||
		lowerFilename === '.dev.vars' ||
		lowerFilename.startsWith('.dev.vars.') ||
		lowerFilename === '.env' ||
		lowerFilename.startsWith('.env.') ||
		SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(filename))
	);
}

function isExcludedFile(filename: string): boolean {
	const lowerFilename = filename.toLowerCase();
	return (
		lowerFilename === '.ds_store' ||
		lowerFilename.endsWith('.swp') ||
		lowerFilename.endsWith('.swo') ||
		lowerFilename.endsWith('~')
	);
}

function isTextContent(content: Buffer): boolean {
	if (content.includes(0)) return false;
	const text = content.toString('utf8');
	return Buffer.from(text, 'utf8').equals(content) && !text.includes('\uFFFD');
}

function decodeSkillModuleId(
	source: string,
	internalPrefix: string,
	encodedInternalPrefix: string,
): string | undefined {
	if (source.startsWith(internalPrefix)) return source;
	const encodedIndex = source.indexOf(encodedInternalPrefix);
	if (encodedIndex !== -1)
		return `${internalPrefix}${source.slice(encodedIndex + encodedInternalPrefix.length)}`;
	return undefined;
}

function isAuthorizedPackagedStoreImporter(
	importer: string | undefined,
	bootstrapEntries: Set<string>,
	trustedVirtualBootstrapIds: Set<string>,
): boolean {
	if (!importer) return false;
	if (importer.startsWith(SKILL_MODULE_PREFIX)) return true;
	if (trustedVirtualBootstrapIds.has(importer)) return true;
	return bootstrapEntries.has(canonicalPath(importer.split('?')[0] ?? importer));
}

function stripQueryAndHash(specifier: string): string {
	return specifier.split(/[?#]/, 1)[0] ?? specifier;
}

function isSkillMarkdownPath(specifier: string): boolean {
	return path.basename(stripQueryAndHash(specifier)) === 'SKILL.md';
}

interface ModuleAst {
	body: unknown[];
}

interface AstNode {
	type?: string;
	source?: { value?: unknown; start?: number; end?: number };
	attributes?: Array<{ key?: { name?: unknown; value?: unknown }; value?: { value?: unknown } }>;
}

interface AttributedImport {
	specifier: string;
	start: number;
	end: number;
}

function collectAttributedImports(
	ast: ModuleAst,
	attributeValue: 'markdown' | 'skill',
): AttributedImport[] {
	const imports: AttributedImport[] = [];
	for (const entry of ast.body) {
		const declaration = entry as AstNode;
		if (
			declaration.type !== 'ImportDeclaration' &&
			declaration.type !== 'ExportNamedDeclaration' &&
			declaration.type !== 'ExportAllDeclaration'
		)
			continue;
		const specifier = declaration.source?.value;
		if (typeof specifier !== 'string') continue;
		const matchesAttribute = declaration.attributes?.some((attribute) => {
			const key = attribute.key?.name ?? attribute.key?.value;
			return key === 'type' && attribute.value?.value === attributeValue;
		});
		if (!matchesAttribute) continue;
		const start = declaration.source?.start;
		const end = declaration.source?.end;
		if (typeof start !== 'number' || typeof end !== 'number') {
			throw new Error(`[flue] Unable to transform ${attributeValue} import: ${specifier}`);
		}
		imports.push({ specifier, start, end });
	}
	return imports;
}

function assertNoDynamicSkillImports(ast: ModuleAst): void {
	visitAst(ast, (node) => {
		if (node.type !== 'ImportExpression') return;
		const specifier = node.source?.value;
		if (typeof specifier === 'string' && isSkillMarkdownPath(specifier)) {
			throw new Error(
				`[flue] Dynamic SKILL.md import "${specifier}" is unsupported. Use a static import with { type: 'skill' }.`,
			);
		}
	});
}

function visitAst(value: unknown, visit: (node: AstNode) => void): void {
	if (!value || typeof value !== 'object') return;
	if (Array.isArray(value)) {
		for (const item of value) visitAst(item, visit);
		return;
	}
	const node = value as AstNode & Record<string, unknown>;
	if (typeof node.type === 'string') visit(node);
	for (const [key, child] of Object.entries(node)) {
		if (key !== 'start' && key !== 'end' && key !== 'loc') visitAst(child, visit);
	}
}
