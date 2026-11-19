# Mac preview releases

Pushing a version tag starts the release. GitHub Actions runs all unit and integration tests and builds the Apple Silicon app. It then runs a short set of packaged UI tests while creating and verifying the DMG. Both must pass before Actions uploads the installer and checksum.

The short suite checks browser sign-in, calendar selection, drag and resize writes to Google and TickTick, and TickTick polling and recovery from a request limit. It uses local test accounts. To run the full set of packaged UI tests, choose **Actions → Mac preview release → Run workflow** and check **Run all packaged UI tests**. On a Mac, `npm run test:e2e` runs the full set and `npm run test:e2e -- --smoke` runs the release checks.

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

The tag must match both package files. Follow the run under **Actions → Mac preview release**. Once the download is public, run `git push origin main` to put the working link on the repository homepage. For a temporary runner or network failure, use **Re-run failed jobs**. For tags created with the updated workflow after `v0.6.1`, you can also choose **Run workflow** and select the existing version tag. A successful run on that tag publishes its verified installer. If the tagged code needs a fix, commit it and tag the next version. Keep published tags and assets intact. [Release runs](https://github.com/mararn1618/calendar-hub/actions/workflows/release.yml)

Preview downloads appear on the full Releases page. GitHub's Latest release shortcut looks for a stable release. [All Calendar Hub releases](https://github.com/mararn1618/calendar-hub/releases)

## Check a build before tagging

Choose **Actions → Mac preview release → Run workflow** and select a branch to test it and download its installer as a workflow artifact.

On an Apple Silicon Mac, `npm ci`, `npm run package:mac`, then `npm run package:dmg` produce the DMG and its checksum under `build/release/`. The mounted image contains the app, a shortcut to Applications and the bundled license notices.

To verify a download, save the DMG and its checksum in the same folder. For version 0.6.1, run `shasum -a 256 -c Calendar-Hub-0.6.1-arm64.dmg.sha256`. From the matching source tag, `bash scripts/package-dmg.sh --verify /path/to/Calendar-Hub-0.6.1-arm64.dmg` also checks the mounted app’s version, architecture and signature.
