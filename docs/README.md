# Documentation

| Area | Start here |
|---|---|
| New to the team | [onboarding.md](onboarding.md), then [../CONTRIBUTING.md](../CONTRIBUTING.md) |
| Architecture decisions | [decisions/](decisions/README.md) |
| Database (ownership, security, tenant isolation, migrations, backups) | [database/](database/README.md) |
| CI, GitHub setup, branch protection | [devops/ci.md](devops/ci.md), [devops/github-repository-setup.md](devops/github-repository-setup.md) |
| Security policy | [../SECURITY.md](../SECURITY.md), [security/](security/README.md) |
| Runbooks | [runbooks/](runbooks/README.md) |
| **Architecture (single source of truth)** | [architecture/](architecture/README.md): blueprint mapping, real-time, design system |
| API conventions | [api/conventions.md](api/conventions.md) |
| Roadmap and phase status | [product/roadmap.md](product/roadmap.md) |
| Testing strategy and acceptance scenarios | [devops/testing-strategy.md](devops/testing-strategy.md) |

Docs live next to the code and change in the same pull request as the behaviour they describe. `database/erd.md` and `database/schema-reference.md` are generated (`make db-docs`); never edit them by hand.
