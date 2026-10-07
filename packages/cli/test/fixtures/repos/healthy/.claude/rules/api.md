---
paths:
  - "src/api/**"
---
# API rules

- Validate every request body with the shared schema in `src/api/schema.mjs`.
- Return problem+json on errors.
