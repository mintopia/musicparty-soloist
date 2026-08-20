## Resources

A Spotify Soloist API Key is in `.env`.

## jcodemunch-mcp (v1.50.0)

Use jcodemunch-mcp tools instead of Grep/Read/Glob for any indexed repository.

### Quick start
1. `list_repos` — check if the project is indexed.
   If not: `index_folder` (local) or `index_repo` (GitHub URL).
2. `search_symbols` — find functions/classes by name or description.
3. `get_context_bundle` — symbol source + imports in one call.
4. `search_text` — full-text/regex search for literals and comments.

### All tools
**Indexing:** `index_repo`, `index_folder`, `summarize_repo`, `index_file`
**Discovery:** `list_repos`, `resolve_repo`, `suggest_queries`, `get_repo_outline`, `get_file_tree`, `get_file_outline`
**Search & Retrieval:** `search_symbols`, `get_symbol_source`, `get_context_bundle`, `get_file_content`, `search_text`, `search_columns`, `get_ranked_context`
**Relationships:** `find_importers`, `find_references`, `check_references`, `get_dependency_graph`, `get_class_hierarchy`, `get_related_symbols`, `get_call_hierarchy`
**Impact & Safety:** `get_blast_radius`, `check_rename_safe`, `get_impact_preview`, `get_changed_symbols`, `plan_refactoring`
**Architecture:** `get_dependency_cycles`, `get_coupling_metrics`, `get_layer_violations`, `get_extraction_candidates`, `get_cross_repo_map`, `get_tectonic_map`, `get_signal_chains`, `render_diagram`, `get_project_intel`
**Quality & Metrics:** `get_symbol_complexity`, `get_churn_rate`, `get_hotspots`, `get_repo_health`, `get_symbol_importance`, `find_dead_code`, `get_dead_code_v2`, `get_untested_symbols`
**Diffs & Embeddings:** `get_symbol_diff`, `embed_repo`
**Session-Aware Routing:** `plan_turn`, `get_session_context`, `get_session_snapshot`, `register_edit`
**Utilities:** `get_session_stats`, `invalidate_cache`, `test_summarizer`, `audit_agent_config`

Never fall back to Grep, Read, or Glob for indexed repos.

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
