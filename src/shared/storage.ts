import type { PageFixArchive } from "./types";
import { startStep } from "./logger";

const PAGE_FIX_PREFIX = "page_fix::";

function storageKey(pageKey: string): string {
  return `${PAGE_FIX_PREFIX}${pageKey}`;
}

export async function loadArchive(pageKey: string, traceId?: string): Promise<PageFixArchive | null> {
  const key = storageKey(pageKey);
  const step = startStep("storage", "archive.load", {
    pageKey,
    storageKey: key,
    traceId
  });

  try {
    const result = await chrome.storage.local.get(key);
    const archive = (result[key] as PageFixArchive | undefined) ?? null;
    step.finish({
      hit: Boolean(archive),
      fixCount: archive?.fixes.length ?? 0
    });
    return archive;
  } catch (error) {
    step.fail(error);
    throw error;
  }
}

export async function saveArchive(archive: PageFixArchive, traceId?: string): Promise<void> {
  const key = storageKey(archive.page_key);
  const step = startStep("storage", "archive.save", {
    pageKey: archive.page_key,
    storageKey: key,
    fixCount: archive.fixes.length,
    traceId
  });

  try {
    await chrome.storage.local.set({
      [key]: archive
    });
    step.finish();
  } catch (error) {
    step.fail(error);
    throw error;
  }
}

export async function listArchivedPageKeys(traceId?: string): Promise<string[]> {
  const step = startStep("storage", "archive.list", {
    traceId
  });

  try {
    const allEntries = await chrome.storage.local.get(null);
    const pageKeys = Object.keys(allEntries)
      .filter((key) => key.startsWith(PAGE_FIX_PREFIX))
      .map((key) => key.slice(PAGE_FIX_PREFIX.length))
      .sort();
    step.finish({
      archiveCount: pageKeys.length,
      pageKeys
    });
    return pageKeys;
  } catch (error) {
    step.fail(error);
    throw error;
  }
}

export async function clearArchivedPages(traceId?: string): Promise<string[]> {
  const step = startStep("storage", "archive.clearAll", {
    traceId
  });

  try {
    const pageKeys = await listArchivedPageKeys(traceId);
    if (pageKeys.length === 0) {
      step.finish({
        clearedCount: 0
      });
      return [];
    }

    await chrome.storage.local.remove(pageKeys.map(storageKey));
    step.finish({
      clearedCount: pageKeys.length,
      pageKeys
    });
    return pageKeys;
  } catch (error) {
    step.fail(error);
    throw error;
  }
}
