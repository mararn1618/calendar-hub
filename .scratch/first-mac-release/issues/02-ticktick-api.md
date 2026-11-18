# Which original TickTick tasks can the app read and change?

Type: research
Label: wayfinder:research
Status: resolved
Assignee: Markus

## Question

What does TickTick's supported public interface document for finding tasks, creating one in a chosen list, changing the dates or duration of that same task, and completing it? Examine Inbox and list coverage, untimed, single-time, ranged and recurring tasks, authorization, and preserving fields that the user has not edited. Distinguish documented behavior from questions that require a disposable-account check.

## Answer

TickTick documents reading, creating, changing the dates of and completing original tasks in writable lists. Dated Inbox tasks have a supported search in windows of up to 14 days. The API can also complete Inbox tasks. A successful create can return no identifier. A task with the same title and time is insufficient to establish its identity. [TickTick Open API](https://developer.ticktick.com/docs/openapi.md)

The spec can target these original-task operations. Date-only and single-time behavior, undated Inbox coverage, preservation of unrelated fields and the effect on later recurring occurrences need checks in a disposable account. Duration is a Premium feature and needs checking on the intended account tier. The report separates these open checks from the documented behavior. [Editing original TickTick tasks](../../../../.calendar-central-ticktick-research/docs/research/ticktick-task-editing.md)

Research branch `research/ticktick-task-editing`, commit `5f835df6bd8735dd5b8b53f542754b222d09b16a`. The report is also available with `git show 5f835df:docs/research/ticktick-task-editing.md`.
