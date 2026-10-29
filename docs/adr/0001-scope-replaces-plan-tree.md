# 0001 — The Scope replaces the session plan tree

**Accepted (2026-01-26)**

This fork removes the original app's per-session plan tree (`plan_init`, the plan panel, status derivations) and replaces it with a persistent Scope: the exhaustive topic map of a learning domain, built through guided Scope Sessions and walked directly by teaching sessions. The plan tree conflated coverage with routing: it was re-authored from scratch each session, so it never guaranteed the whole domain was covered — it only covered what the teacher happened to think of. The Scope separates those concerns: exhaustive coverage lives in a persistent artifact; routing is the teacher's per-session judgment informed by probe results and Dependency Edges (dependency orderings discovered and accumulated during teaching, never authored upfront).

Considered and rejected:

- **Seeding the session plan from the Scope** (plan nodes = Scope topics): keeps two parallel map artifacts, one dying each session, one persistent — redundant state to maintain and reconcile.
- **Fixed dependency trees authored during the Scope Session**: premature — at scope-definition time the learner doesn't know the domain and cannot validate prerequisite structure.

Consequences: dependency knowledge is partial early on and grows with teaching; Free Sessions (no Scope) are pure chat with no map; the removal touches tools, UI panel, contracts, and tests of the original plan machinery.
