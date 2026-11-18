# Specify Calendar Central for Mac

Label: wayfinder:map

## Destination

A build-ready spec for a Mac app that brings TickTick tasks, Google events and BMW meetings into one editable calendar, with acceptance examples and a roadmap for direct Exchange access.

## Notes

- The [working spec](spec.md) records the scope agreed in the opening discussion. The [original request](../../context/braindump.txt) and [glossary](../../GLOSSARY.md) give the product context.
- The [Daymark reference](daymark.md) identifies existing gestures, provider code and verification limits at commit `89e8357d7cc5b8aadfbd01562a4caaad2db9e72d`.
- Use Grilling and Domain Modeling for product decisions. Use Prototype to discuss scrolling with a concrete example. Use Research and first-party sources for questions about provider capabilities.
- The map and its child tickets use the local Markdown tracker. Each research ticket links its supporting report and records the local Git branch.

## Decisions so far

## Not yet specified

- Any checks that need a disposable provider account or company approval will take shape once the documented limits are known.
- The final end-to-end examples will need realistic cases from the agreed calendar interactions, particularly where task dates, calendar access and changes made elsewhere meet.

## Out of scope

- Implementing and distributing the app belongs to the build after this specification.
- Windows is a possible later release. Mobile and the separate Google Tasks service are outside the first Mac release.
- Replacing TickTick's full task manager is outside this effort. TickTick continues to own the tasks.
