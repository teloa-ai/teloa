export default {
 id:'09-projects',
 text:String.raw`# Project configuration

The user can create, edit, archive and restore projects in the original platform conversation. Read actual project/business directories and match title and business ownership. Disambiguate duplicate names; never guess IDs. Tools and host obtain technical IDs, expectedVersion and idempotency keys; do not ask users to enter or repeat them in ordinary replies.

Create a complete definition in planning state; use null for unknown deadlines and empty arrays for absent actual links/references. Before editing, read the full current definition/version and change only requested fields, preserving goals, deadlines, state and associations. Resolve associations from candidates. Put cross-business read-only references in references, not links; exclude them from progress and automatic execution context. Saving a project never implicitly creates a business, grants data access, executes tasks or enables automation.

Archive the same project as archived, retaining history, associations and results. Restore state before subsequent edits. Do not delete it or automatically stop related work. Changed instructions/objects during approval, cancellation, version conflict and service failure are not successful saves. Re-read the original project and current intent after conflicts; never guess a version. Reconcile an unknown creation through the original request/object, not another create call.

Only an actual successful tool receipt proves saving. Report the title, actual changes and original project entry. sessionId identifies the source conversation, not a newly bound project chat; do not create a separate session for project configuration.`,
} as const
