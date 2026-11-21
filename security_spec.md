# Atlas CTF Security Specification (Phase 0: Payload-First Security TDD)

## 1. Data Invariants

1. **Identity & Self-Assigned Role Prohibition**:
   - A newly registered user creating `/users/{userId}` MUST set `uid == request.auth.uid`, `role == 'player'`, and `status == 'active'` (unless authenticated as a verified administrator).
   - Non-admin users can NEVER elevate their own `role` (`player` -> `organizer` or `admin`) or change `status`.
   - Admin and Organizer authority MUST be verified strictly against trusted server-controlled lookup collections (`/admins/{uid}`, `/organizers/{uid}`) or the bootstrapped verified admin email (`zezu1811@gmail.com` with `email_verified == true`), NEVER client claims or mutable user profile fields.
2. **PII Isolation**:
   - Email addresses are strictly isolated inside `/users/{userId}/private/account` and are NEVER stored on public `/users/{userId}` documents.
   - Only the account owner (`request.auth.uid == userId`) or a verified Admin can read `/users/{userId}/private/{docId}`.
3. **Challenge Management RBAC**:
   - Only verified Organizers or Admins can create, update, or publish `/challenges/{challengeId}` documents.
   - Only verified Admins can delete `/challenges/{challengeId}` documents.
   - Players can only read/list challenges where `published == true`.
   - Plaintext flags are never stored in Firestore; only 64-character lowercase SHA-256 hex digests (`flagHash`) are stored.
4. **Progress Ownership & Terminal Solve Locking**:
   - Users can only create or update `/progress/{progressId}` where `uid == request.auth.uid`.
   - Once a progress record reaches terminal `status == 'solved'`, non-admin users cannot downgrade `status` or alter `pointsEarned`; they may only edit their personal `notes` field.
5. **Temporal Integrity & Strict Schema Keys**:
   - Every write enforces `createdAt == request.time` on creation (and immutability on update) and `updatedAt == request.time` on both creation and update.
   - Every string and map field is bounded by strict `.size()` limits, and every document ID path variable is guarded by `isValidId()` (`^[a-zA-Z0-9_\-]+$`, max 128 chars).

## 2. The "Dirty Dozen" Adversarial Payloads

| # | Attack Vector | Target Collection | Malicious Payload / Operation | Expected Result |
| :- | :--- | :--- | :--- | :--- |
| 1 | Self-Assigned Admin Role | `/users/{uid}` (create) | `{ uid, handle: "evil", role: "admin", status: "active", ... }` | `PERMISSION_DENIED` |
| 2 | Role Escalation via Update | `/users/{uid}` (update) | `{ role: "organizer", updatedAt: serverTimestamp() }` | `PERMISSION_DENIED` |
| 3 | Shadow / Ghost Field Injection | `/users/{uid}` (create) | `{ uid, handle: "pwn", isVerified: true, role: "player", ... }` | `PERMISSION_DENIED` |
| 4 | PII Cross-User Read | `/users/{otherUid}/private/account` (get) | Read another user's private email document as a player | `PERMISSION_DENIED` |
| 5 | Unverified Email Admin Spoof | `/admins/{uid}` (create) | Spoofed `email: "zezu1811@gmail.com"` with `email_verified: false` | `PERMISSION_DENIED` |
| 6 | Player Challenge Injection | `/challenges/fake_01` (create) | Player attempts to create a challenge with `points: 2000` | `PERMISSION_DENIED` |
| 7 | Organizer Deleting Challenges | `/challenges/nm-01` (delete) | Organizer attempts to delete a challenge (Admin-only) | `PERMISSION_DENIED` |
| 8 | Draft Challenge Scraping | `/challenges` (list) | Player queries unpublished draft challenges (`published == false`) | `PERMISSION_DENIED` |
| 9 | Identity Spoofing in Progress | `/progress/other_nm-01` (create) | User A submits progress with `uid: "user_B"` | `PERMISSION_DENIED` |
| 10 | Terminal State Downgrade | `/progress/{uid}_nm-01` (update) | Player tries to change solved progress back to `in_progress` or inflate `pointsEarned` | `PERMISSION_DENIED` |
| 11 | Client Timestamp Forgery | `/challenges/nm-02` (create) | Organizer sends client-forged `createdAt: Timestamp(2020-01-01)` | `PERMISSION_DENIED` |
| 12 | Resource / ID Poisoning | `/challenges/<150-char-junk>` (create) | Oversized invalid document ID or 50KB `summary` string | `PERMISSION_DENIED` |

## 3. Red Team Audit Matrix

- **Shadow Update Test**: Every `create` checks `data.keys().hasAll(...) && data.keys().hasOnly(...)`; every `update` action checks `incoming().diff(existing()).affectedKeys().hasOnly(...)` AND begins with `isValid[Entity](incoming())`.
- **Email Spoofing Test**: `isBootstrapAdmin()` strictly requires `request.auth.token.email == 'zezu1811@gmail.com' && request.auth.token.email_verified == true`.
- **PII Blanket Test**: `/users/{userId}` excludes emails; `/users/{userId}/private/{docId}` denies `list` and restricts `get` strictly to `isOwner(userId) || isAdmin()`.
- **Query Trust Test**: Zero blanket `allow list: if isSignedIn();` rules and zero `get()`/`exists()` calls inside `allow list`. Every `allow list` enforces `resource.data` invariants directly.
