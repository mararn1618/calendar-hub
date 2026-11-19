# Mac preview releases

Pushing a tag such as `v0.5.0` starts the release. GitHub Actions runs the automated tests, builds the Apple Silicon app, exercises the packaged app with test accounts, and mounts the DMG to verify it. Once the checks pass, Actions publishes a GitHub prerelease with the installer and its SHA-256 checksum.

## Choose the version

The first preview is `0.4.0`. Choose the next version by hand. During the preview, use `0.4.1` for fixes and `0.5.0` for new features. Mention any changes to existing behavior or saved data in the release notes. Use `1.0.0` when users can rely on stable upgrades. After that, use a major version for incompatible changes, a minor version for compatible features and a patch version for fixes. [Semantic Versioning](https://semver.org/)

## Publish

From an up-to-date `main`, set the version in the manifest and lockfile and update the DMG link at the top of the README. For example, to publish a patch after `0.6.1`, run these commands. Git opens an editor for the tag message. Describe what changed for people downloading the app. That message appears on the release page.

```sh
npm version 0.6.2 --no-git-tag-version
# Update the download link in README.md.
git add package.json package-lock.json README.md
git commit -m "Prepare version 0.6.2"
git tag -a v0.6.2
git push origin v0.6.2
```

The tag must match both package files. Follow the run under **Actions → Mac preview release**. Once the download is public, run `git push origin main` to put the working link on the repository homepage. A failed check leaves the download unpublished. For a temporary runner or network failure, use **Re-run failed jobs**. If the tagged code needs a fix, commit it and tag the next version. Keep published tags and assets intact. [Release runs](https://github.com/mararn1618/calendar-hub/actions/workflows/release.yml)

Preview downloads appear on the full Releases page. GitHub's Latest release shortcut looks for a stable release. [All Calendar Hub releases](https://github.com/mararn1618/calendar-hub/releases)

## Check a build before tagging

Choose **Actions → Mac preview release → Run workflow** to test a branch and download its installer as a workflow artifact. Publishing starts only on a tag push.

On an Apple Silicon Mac, `npm ci`, `npm run package:mac`, then `npm run package:dmg` produce the DMG and its checksum under `build/release/`. The mounted image contains the app, a shortcut to Applications and the bundled license notices.

To verify a download, save the DMG and its checksum in the same folder. For version 0.6.1, run `shasum -a 256 -c Calendar-Hub-0.6.1-arm64.dmg.sha256`. From the matching source tag, `bash scripts/package-dmg.sh --verify /path/to/Calendar-Hub-0.6.1-arm64.dmg` also checks the mounted app’s version, architecture and signature.
