'use client'

import { useInfiniteQuery } from '@tanstack/react-query'
import { apiFetch } from './api'

// the API clamps to its own maximum, so this is a request, not a promise of how many rows come back
export const PAGE_SIZE = 50

export type Paged<T> = {
  rows: T[]
  error: unknown
  loading: boolean
  hasMore: boolean
  loadingMore: boolean
  loadMore(): void
  reload(): void
}

type Page = { cursor?: unknown } & Record<string, unknown>

// Every list route answers `{ <field>: [...], cursor? }` and takes the cursor back verbatim, so the cursor is
// only ever passed on and never read.
export function usePagedList<T>(
  path: string,
  field: string,
  params: Record<string, string | undefined> = {},
  enabled = true,
): Paged<T> {
  const query = useInfiniteQuery({
    queryKey: [path, params],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams({ limit: String(PAGE_SIZE) })
      for (const [name, value] of Object.entries(params)) if (value !== undefined) search.set(name, value)
      if (pageParam) search.set('cursor', pageParam)
      return apiFetch<Page>(`${path}?${search}`)
    },
    getNextPageParam: (last) => (typeof last.cursor === 'string' && last.cursor ? last.cursor : undefined),
  })

  return {
    rows: (query.data?.pages ?? []).flatMap((page) => (page[field] as T[] | undefined) ?? []),
    error: query.error,
    loading: enabled && query.isPending,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    reload: () => void query.refetch(),
  }
}
