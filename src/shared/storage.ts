import type { PageFixArchive } from "./types";

function storageKey(pageKey: string): string {
  return `page_fix::${pageKey}`;
}

export async function loadArchive(pageKey: string): Promise<PageFixArchive | null> {
  const result = await chrome.storage.local.get(storageKey(pageKey));
  return (result[storageKey(pageKey)] as PageFixArchive | undefined) ?? null;
}

export async function saveArchive(archive: PageFixArchive): Promise<void> {
  await chrome.storage.local.set({
    [storageKey(archive.page_key)]: archive
  });
}
