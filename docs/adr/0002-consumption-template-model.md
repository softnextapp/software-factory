# Consumption is a clone-and-own template, not a submodule

**Status**: Accepted (2026-08-04)

A project consumes the Factory by cloning it (or using it as a GitHub template) and dropping `.git`; the `.sandcastle/` + `.claude/` config becomes the project's own, with no ongoing link. We chose template over submodule because the Omniris consumer repos live on a private GitLab (`gitlab.omniris.com`) while the Factory lives on GitHub (`softnextapp`) — a submodule would embed a cross-host, cross-org dependency in every commit, breaking the moment an agent or CI can't reach GitHub. The Factory still earns its keep as the ever-improving reference each new project clones from; drift in *existing* instances is managed by manual re-sync, not a fragile automated link.

**Rejected**: git submodule (automatic propagation, at the cost of cross-host coupling in every consumer commit).
