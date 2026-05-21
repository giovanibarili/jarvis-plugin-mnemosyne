.PHONY: install test typecheck clean seed-v12

# Wraps npm install with a clean registry override.
# Required because the user-level shell exports `npm_config_registry` pointing
# at Nubank CodeArtifact (private registry), which lacks public packages
# like chromadb, neo4j-driver, etc. The local .npmrc alone cannot win against
# the env var, so we strip it here.
install:
	@unset npm_config_registry && npm install --registry=https://registry.npmjs.org/

test:
	@npm test

typecheck:
	@npx tsc --noEmit

clean:
	@rm -rf node_modules dist

seed-v12:
	@unset npm_config_registry && npx --registry=https://registry.npmjs.org/ tsx scripts/seed-v12-catalog.ts
