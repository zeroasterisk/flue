import type { APIRoute } from 'astro';
import { getCollection, type CollectionEntry } from 'astro:content';

interface Props {
	entry: CollectionEntry<'docs'>;
}

export async function getStaticPaths() {
	const entries = await getCollection('docs');

	return entries.map((entry) => ({
		params: { slug: entry.id },
		props: { entry },
	}));
}

export const GET = (({ props }) => {
	const { entry } = props as Props;
	const markdown = `# ${entry.data.title}\n\n${entry.body ?? ''}`;

	return new Response(markdown, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
		},
	});
}) satisfies APIRoute;
