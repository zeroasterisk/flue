import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { z } from 'astro/zod';

export const collections = {
	docs: defineCollection({
		loader: docsLoader(),
		schema: docsSchema({
			extend: z.object({
				lastReviewedAt: z.coerce.date().optional(),
				subtitle: z.string().optional(),
				package: z
					.object({
						name: z.string(),
						href: z.url(),
					})
					.optional(),
			}),
		}),
	}),
};
