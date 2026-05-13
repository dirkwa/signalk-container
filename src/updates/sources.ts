import type { VersionSource, VersionSourceResult } from "./types.js";

export type FetchImpl = typeof fetch;

export interface GithubReleasesOptions {
  allowPrerelease?: boolean;
  /** Strip a prefix from tag_name before returning, e.g. "v" → "1.2.3". */
  tagPrefix?: string;
  /** GitHub personal access token (Authorization: Bearer …) for higher rate limit. */
  token?: string;
  /** Override fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: FetchImpl;
  /** Per-request timeout in ms. Default 10000. */
  timeoutMs?: number;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at?: string;
}

/**
 * Version source backed by the GitHub releases REST API. Fetches the
 * 5 most recent releases, filters drafts and (optionally) prereleases,
 * and returns the newest stable tag_name. Strips an optional prefix
 * (typically "v") so the result is comparable via compareVersions().
 */
export function githubReleases(
  repo: string,
  options: GithubReleasesOptions = {},
): VersionSource {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10000;
  const tagPrefix = options.tagPrefix ?? "";

  return {
    async fetch(): Promise<VersionSourceResult> {
      const url = `https://api.github.com/repos/${repo}/releases?per_page=5`;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
      };
      if (options.token) headers.Authorization = `Bearer ${options.token}`;

      const res = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        return {
          kind: "error",
          error: `GitHub API ${res.status} for ${repo}`,
        };
      }

      let releases: GitHubRelease[];
      try {
        releases = (await res.json()) as GitHubRelease[];
      } catch (err) {
        return {
          kind: "error",
          error: `GitHub API parse failure: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (!Array.isArray(releases)) {
        return { kind: "error", error: "GitHub API: response is not an array" };
      }

      const candidate = releases.find(
        (r) => !r.draft && (options.allowPrerelease || !r.prerelease),
      );
      if (!candidate) {
        return { kind: "error", error: `No matching release for ${repo}` };
      }

      let tag = candidate.tag_name;
      if (tagPrefix && tag.startsWith(tagPrefix)) {
        tag = tag.slice(tagPrefix.length);
      } else if (!tagPrefix && tag.startsWith("v")) {
        // Default behavior: strip leading "v" so tags like "v1.2.3" are
        // directly comparable to image tags like "1.2.3".
        tag = tag.slice(1);
      }

      return { kind: "version", latest: tag };
    },
  };
}

export interface DockerHubTagsOptions {
  filter?: (tag: string) => boolean;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

interface DockerHubTagResponse {
  results?: { name: string }[];
}

/**
 * Version source backed by the Docker Hub v2 tags API. Returns the
 * first tag matching the filter (default: anything that parses as
 * a semver). Useful for images that don't have GitHub releases.
 */
export function dockerHubTags(
  image: string,
  options: DockerHubTagsOptions = {},
): VersionSource {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10000;
  const filter =
    options.filter ?? ((t: string) => /^v?\d+\.\d+(\.\d+)?$/i.test(t));

  return {
    async fetch(): Promise<VersionSourceResult> {
      // Docker Hub expects "library/foo" for official images, "user/foo" otherwise.
      const path = image.includes("/") ? image : `library/${image}`;
      const url = `https://hub.docker.com/v2/repositories/${path}/tags/?page_size=25`;

      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        return {
          kind: "error",
          error: `Docker Hub API ${res.status} for ${image}`,
        };
      }

      let body: DockerHubTagResponse;
      try {
        body = (await res.json()) as DockerHubTagResponse;
      } catch (err) {
        return {
          kind: "error",
          error: `Docker Hub parse failure: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const tags = body.results ?? [];
      const match = tags.find((t) => filter(t.name));
      if (!match) {
        return {
          kind: "error",
          error: `No matching tag for ${image} on Docker Hub`,
        };
      }

      let tag = match.name;
      if (tag.startsWith("v")) tag = tag.slice(1);
      return { kind: "version", latest: tag };
    },
  };
}
