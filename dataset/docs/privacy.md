# Private data and releases

Git stores the schema, tools, and small fixtures. The Waterfall Dataset release contains simulated trajectories and their evaluation records. Production exports, identity mappings, cookies, API credentials, downloaded source material and human labels belong in private storage outside this checkout. The synthetic snapshot stores source links and fingerprints with its simulated profiles, events and labels. Ignore rules are defense in depth and do not authorize committing sensitive data.

A participant/session ID may identify a person; private-export identifiers are not anonymization. Actual model prompts/responses and natural text can contain personal information. The formatter removes known secret key names, authorization/cookie headers and bearer-token patterns; it does not guarantee arbitrary free-text secrets or personal identities have been removed. Review real account exports for personal information before sharing them. Large original media and binary data are outside the format.

MIT covers original code/documentation and fictional fixture authored in this repository. No license is granted here for third-party source material or future human exports. The dataset release manifest describes the records included in that pack.

Download/import refuse overwrite. HTTP is accepted only for localhost QA; remote downloads require HTTPS, and redirects across origins are rejected to protect environment-supplied authentication. Import validates the complete transport before atomically renaming a new directory. It never automatically resolves external artifact URLs or uploads a private export. Do not use a private transport as a public CI fixture.
