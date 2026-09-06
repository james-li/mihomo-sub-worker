export async function mapConcurrent<T, R>(
	items: readonly T[],
	limit: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const workers = Array.from(
		{ length: Math.min(Math.max(limit, 1), items.length) },
		async () => {
			while (nextIndex < items.length) {
				const index = nextIndex;
				nextIndex += 1;
				results[index] = await mapper(items[index], index);
			}
		},
	);
	await Promise.all(workers);
	return results;
}
