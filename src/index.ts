import * as core from "@actions/core";
import * as github from "@actions/github";
import { setupGitCredentials, setupGitUser } from "./utils";
import fetch from "node-fetch";
import { getPackages } from "@manypkg/get-packages";
import path from "path";
import { PackageJSON } from "@changesets/types";
import { diff, IChange, Operation } from "json-diff-ts";
import { read, defaultConfig } from "@changesets/config";
import { stat, mkdirp, writeFile, unlink } from "fs-extra";
import * as gitUtils from "./git-utils";
import sanitize from "sanitize-filename";
import { coerce as coerceVersion } from "semver";

function textify(d: IChange, location: string) {
  const link = `[\`${d.key}@${d.value}\` ↗︎](https://www.npmjs.com/package/${
    d.key
  }/v/${coerceVersion(d.value)?.version ?? d.value})`;

  switch (d.type) {
    case Operation.ADD: {
      return `Added dependency ${link} (to \`${location}\`)`;
    }
    case Operation.UPDATE: {
      return `Updated dependency ${link} (from \`${d.oldValue}\`, in \`${location}\`)`;
    }
    case Operation.REMOVE: {
      return `Removed dependency ${link} (from \`${location}\`)`;
    }
  }
}

async function fetchFile(
  pat: string,
  file: {
    path: string;
    owner: string;
    repo: string;
    ref: string;
  }
) {
  return await fetch(
    `https://raw.githubusercontent.com/${file.owner}/${file.repo}/${file.ref}/${file.path}`,
    {
      headers: {
        Authorization: `Token ${pat}`,
      },
    }
  ).catch((err) => {
    console.error(err);

    throw err;
  });
}

async function fetchJsonFile(
  pat: string,
  file: {
    path: string;
    owner: string;
    repo: string;
    ref: string;
  }
) {
  return await fetchFile(pat, file)
    .then((x) => x.json())
    .catch(() => null);
}

(async () => {
  let githubToken = process.env.GITHUB_TOKEN;

  if (!githubToken) {
    core.setFailed("Please add the GITHUB_TOKEN to the changesets action");
    return;
  }

  const baseSha = github.context.payload.pull_request?.base.sha;

  if (!baseSha) {
    core.setFailed(
      "Please find base SHA, please make sure you are running in a PR context"
    );
    return;
  }

  await setupGitUser();
  await setupGitCredentials(githubToken);

  const issueContext = github.context.issue;

  if (!issueContext?.number) {
    core.warning(`Failed to locate a PR associated with the Action context:`);
    core.setFailed(`Failed to locate a PR associated with the Action context`);

    return;
  }

  const packages = await getPackages(process.cwd());
  const changesetsConfig = await read(process.cwd(), packages).catch((e) => {
    console.warn(
      `Failed to read changesets config: ${e.message}, using default config...`
    );

    return defaultConfig;
  });
  const relevantPackages = packages.packages
    .filter(
      (pkg) =>
        !changesetsConfig.ignore.includes(pkg.packageJson.name) &&
        !pkg.packageJson.private
    )
    .map((p) => ({
      ...p,
      absolutePath: `${p.dir}/package.json`,
      relativePath: path.relative(process.cwd(), `${p.dir}/package.json`),
    }));

  console.debug(
    "found relevant packages to check:",
    relevantPackages.map((v) => v.packageJson?.name || v.dir)
  );

  const changes = new Map<
    string,
    {
      dependencies: IChange[];
      peerDependencies: IChange[];
    }
  >();

  for (const pkg of relevantPackages) {
    const oldPackageFile = (await fetchJsonFile(githubToken!, {
      ...github.context.repo,
      path: pkg.relativePath,
      ref: baseSha,
    })) as PackageJSON;

    if (oldPackageFile) {
      if (!changes.has(pkg.packageJson.name)) {
        changes.set(pkg.packageJson.name, {
          dependencies: [],
          peerDependencies: [],
        });
      }

      changes.get(pkg.packageJson.name)!.dependencies = diff(
        oldPackageFile.dependencies || {},
        pkg.packageJson.dependencies || {}
      );
      changes.get(pkg.packageJson.name)!.peerDependencies = diff(
        oldPackageFile.peerDependencies || {},
        pkg.packageJson.peerDependencies || {}
      );
    } else {
      core.warning(
        `Failed to locate previous file content of ${pkg.relativePath}, skipping ${pkg.packageJson.name}...`
      );
    }
  }

  const branch = github.context.payload.pull_request!.head.ref;
  await gitUtils.fetch();
  await gitUtils.switchToMaybeExistingBranch(branch);

  const changesetBase = path.resolve(process.cwd(), ".changeset");
  await mkdirp(changesetBase).catch(() => null);

  for (const [key, value] of changes) {
    const changes = [
      ...value.dependencies.map((d) => textify(d, "dependencies")),
      ...value.peerDependencies.map((d) => textify(d, "peerDependencies")),
    ].map((t) => `- ${t}`);

    console.debug("package update summary", {
      key,
      changes,
    });

    const cleanName = sanitize(key, {
      replacement: "_",
    });
    const filePath = path.resolve(
      changesetBase,
      `${cleanName}-${issueContext.number}-dependencies.md`
    );

    if (changes.length === 0) {
      const stats = await stat(filePath).catch(() => null);

      if (stats && stats.isFile()) {
        await unlink(filePath);
      }

      continue;
    }

    const changeset = {
      releases: [
        {
          name: key,
          type: "patch",
        },
      ],
      summary: changes.join("\n"),
    };

    const changesetContents = `---
${changeset.releases
  .map((release) => `"${release.name}": ${release.type}`)
  .join("\n")}
---

dependencies updates: 

${changeset.summary}
`;

    console.debug(`Writing changeset to ${filePath}`, changesetContents);

    await writeFile(filePath, changesetContents);
  }

  if (!(await gitUtils.checkIfClean())) {
    await gitUtils.commitAll(
      `chore(dependencies): updated changesets for modified dependencies`
    );
    await gitUtils.push();
  }
})().catch((err) => {
  console.error(err);
  core.setFailed(err.message);
});
