/**
 * sanitize.js — small input sanitizers.
 *
 * F4 (Security): when user-supplied search terms get interpolated into a
 * PostgREST `.or()` or `.ilike()` filter, certain characters can either
 * inject extra clauses or break the filter parser. Strip them out before
 * the value ever reaches Supabase.
 *
 * Reserved in a PostgREST `.or()` value list:
 *   - `,`  separates clauses ("a.eq.1,b.eq.2")
 *   - `(` `)`  group/negate ("not(a.eq.1)")
 *   - `:`  used by ?or in URL form, plus aliasing
 *   - `*`  not a PostgREST meta char itself, but in ilike it's a literal
 *          we don't want to allow as a free-form wildcard either
 *
 * We also cap the length so a 50KB ?q= can't blow up the filter URL.
 *
 * @param {*} q anything (string|undefined|null|object)
 * @returns {string} sanitized search string (possibly empty)
 */
function sanitizePostgrestSearch(q) {
  return String(q == null ? '' : q).replace(/[,():*]/g, '').slice(0, 100);
}

module.exports = { sanitizePostgrestSearch };
