# `unpinned-images` -  Container Images Not Pinned to Digest

zizmor flags container images in `services:` or `container:` blocks that use a tag without
a SHA256 digest. Tags are mutable -  a compromised registry could serve different content
under the same tag.

**Suppress (default).** Determining the correct digest for a container image is nontrivial
(multi-arch manifests, registry-specific behavior, digest instability across rebuilds).
Suppress with a reason.

```yaml
image: myorg/myimage:1.0.0 # zizmor: ignore[unpinned-images] -- version tag is fine for service containers
```

A stronger option is to install the tool from a release and check its checksum yourself. That means a version and a checksum to bump by hand, because Dependabot will not do it. It is not the default. Do not reopen a suppression that was already accepted. Do not write a step that downloads and runs code. If you think it is worth doing, propose it to the owner.
