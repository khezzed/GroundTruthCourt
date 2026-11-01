# GroundTruth Court

An open adversarial argumentation court contract on GenLayer implementing Dung's grounded semantics. Validators never judge overall cases or truth claims globally; instead, isolated LLM prompts evaluate only local, pairwise facts: (1) whether evidence supports an argument's premise, and (2) whether an attacker argument defeats its target argument. A deterministic Python fixpoint algorithm computes the unique 3-valued grounded labelling (`IN`, `OUT`, `UNDEC`) over the resulting directed graph, guaranteeing non-monotonic reinstatement ($A \leftarrow B \leftarrow C \implies A \text{ IN}$) while mutual attacks and cycles fail closed to `UNDEC`/`UNRESOLVED`.

**Deployed StudioNet (Chain ID 61999):** [`0x690DD0244D7918A25d86E24C40E421A25759Bc82`](https://explorer-studio.genlayer.com/address/0x690DD0244D7918A25d86E24C40E421A25759Bc82)  
**Contract Source Commit:** [`c16d7ef`](https://github.com/khezzed/GroundTruthCourt/commit/c16d7ef11cea48034ad4fd5bf5453d08efec8729) | **Git Blob:** `fe63af4e651c2f56b519552c132b20ed279bc585` | **SHA-256:** `6f3e70c15b9c6c600f9fd2a3486aafddbf6615147f6c8f9a835c1d783cdfcbd9`  
**Manifest & Proof:** [`deploy/manifest.json`](deploy/manifest.json) (100% byte-for-byte on-chain equality verified)

### Finalized Live StudioNet Demo (v2)

| Step | Method | Description | Outcome | StudioNet Explorer Tx |
|---|---|---|---|---|
| **R1** | `open_case` | Case R: v2 backward compatibility (`e0`) | OPEN (root IN) | [`0x896dd100...`](https://explorer-studio.genlayer.com/tx/0x896dd100717563cac682bb3ea1a05b0b13f29a840b4b7434ed575aefaf99b432) |
| **R2** | `attack` | Case R: rc1 strict removal breaks callers (`e1`) | ADMITTED:ARG_1 (root OUT) | [`0x1bd55250...`](https://explorer-studio.genlayer.com/tx/0x1bd552506fa94bafa46e499682c4cd14e5de9aa5ae67cde7b0e1c2157bcb2009) |
| **R3** | `attack` | Case R: rc1 reverted before final tag (`e2`) | ADMITTED:ARG_2 (root IN) | [`0x5032ec7c...`](https://explorer-studio.genlayer.com/tx/0x5032ec7c5020c8aa7850bf2bd1ec660627d033e6ac3962f6317fc1cc7ede392a) |
| **M1** | `open_case` | Case M: K-17 melts at 120 °C (`e3`) | OPEN (root IN) | [`0x27316a7f...`](https://explorer-studio.genlayer.com/tx/0x27316a7f37ecc7f086bfd4985e44239486a491ad436ec537f4f43e53bf7e4a9b) |
| **M2** | `attack` | Case M: batch 7 contaminated (`e4`) | ADMITTED:ARG_1 (root OUT) | [`0x12311072...`](https://explorer-studio.genlayer.com/tx/0x123110726b7bfd964fe1812f92c1d5cf3cf0e5e5fc970d7903b54ef9798c5843) |
| **M3** | `add_edge` | Case M: Lab B thermometer expired (`e3`) | ADMITTED:EDGE_0_1 (UNDEC) | [`0xf4617956...`](https://explorer-studio.genlayer.com/tx/0xf461795638c38364b561131f41b387b44f53db4f3b8c29e54212e7caeb94316b) |
| **X1** | `attack` | [Expected Failure] Unrelated cookies evidence (`e5`) | REJECTED (abuse blocked) | [`0x1e29ecf1...`](https://explorer-studio.genlayer.com/tx/0x1e29ecf197f3a386e292a75284e1e3542278cc69740f1d042e2644fa31756e39) |
| **X2** | `attack` | [Expected Failure] Exact duplicate attack replay | UserError: REPLAY | [`0xeedc98e7...`](https://explorer-studio.genlayer.com/tx/0xeedc98e72989630bdf1b2fbdccddbce15cc5568e6b5790fc806e34e058292403) |
| **X3** | `add_edge` | [Expected Failure] Non-author Account C edge injection | UserError: unauthorized | [`0x0c4ee499...`](https://explorer-studio.genlayer.com/tx/0x0c4ee49933bb2b1f8cdbe4fb0ecf04c7ca601ccadee8f5c26db4ad12aceaafe7) |
| **X4** | `attack` | [Expected Failure] Mutable unpinned `/main/` URL | UserError: INVALID_URL | [`0xc8cf5bf6...`](https://explorer-studio.genlayer.com/tx/0xc8cf5bf658ad42d4507264ef6efe60c1e23d174c2fc024a5896c22c4e4b25911) |
| **X5** | `resolve` | [Expected Failure] Premature resolution before deadline | UserError: DEADLINE | [`0x8c09470d...`](https://explorer-studio.genlayer.com/tx/0x8c09470d836c4c517befebb8976b3f53238c0979409abf01703fa1df01aa081b) |
| **F1** | `resolve` | Post-deadline resolution of Case R | UPHELD | [`0xc0fce4fa...`](https://explorer-studio.genlayer.com/tx/0xc0fce4fa795c2f0baf5c6052ec1307ecd550d17eee50a5993d084d1e28f9351f) |
| **F2** | `resolve` | Post-deadline resolution of Case M | UNRESOLVED | [`0x799ff217...`](https://explorer-studio.genlayer.com/tx/0x799ff2170fa8b834fa87b710bee312494b845eb72d8f03fd26ef8ea074e88e06) |
| **X6** | `resolve` | [Expected Failure] Double resolution of Case R | UserError: final | [`0x3004d2aa...`](https://explorer-studio.genlayer.com/tx/0x3004d2aabb49b8dc5b02c38129a830a8603f5621f18540e3d0743a1c7ac6849b) |

**Local Testing:** Run `pytest tests -v` (39 unit and direct-mode simulation tests pass).  
**Honest Scope:** Demonstrates deterministic Dung graph semantics over synthetic pinned UTF-8 text evidence; does not handle financial token/value escrow transfers.
