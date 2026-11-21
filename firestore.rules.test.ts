/**
 * Atlas CTF Firestore Rules Security Test Specification
 * Verifies the "Dirty Dozen" adversarial payloads are rejected with PERMISSION_DENIED.
 * Intended for execution with @firebase/rules-unit-testing against the Firebase Emulator.
 */

export interface DirtyDozenCase {
  id: number;
  name: string;
  actor: 'player' | 'organizer' | 'unverified_spoof' | 'admin';
  operation: 'create' | 'update' | 'delete' | 'get' | 'list';
  path: string;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_CASES: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Self-Assigned Admin Role on Registration',
    actor: 'player',
    operation: 'create',
    path: '/users/player_1',
    payload: {
      uid: 'player_1',
      handle: 'evil_root',
      displayName: 'Evil',
      teamName: '',
      role: 'admin',
      requestedRole: 'none',
      status: 'active',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Self Role Escalation on Profile Update',
    actor: 'player',
    operation: 'update',
    path: '/users/player_1',
    payload: {
      role: 'organizer',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Shadow Ghost Field Injection',
    actor: 'player',
    operation: 'create',
    path: '/users/player_1',
    payload: {
      uid: 'player_1',
      handle: 'ghost_user',
      displayName: 'Ghost',
      teamName: '',
      role: 'player',
      requestedRole: 'none',
      status: 'active',
      isVerified: true,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Cross-User PII Account Read',
    actor: 'player',
    operation: 'get',
    path: '/users/other_user/private/account',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Unverified Email Admin Spoofing',
    actor: 'unverified_spoof',
    operation: 'create',
    path: '/admins/spoof_uid',
    payload: {
      uid: 'spoof_uid',
      grantedBy: 'spoof',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Unauthorized Player Challenge Creation',
    actor: 'player',
    operation: 'create',
    path: '/challenges/pwn-fake',
    payload: {
      id: 'pwn-fake',
      title: 'Injected Challenge',
      points: 2000,
      published: true,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Organizer Attempting Admin-Only Challenge Deletion',
    actor: 'organizer',
    operation: 'delete',
    path: '/challenges/nm-01-csaw18-getit',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Player Listing Unpublished Draft Challenges',
    actor: 'player',
    operation: 'list',
    path: '/challenges',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Identity Spoofing in Progress Document',
    actor: 'player',
    operation: 'create',
    path: '/progress/victim_nm-01',
    payload: {
      uid: 'victim',
      handle: 'victim',
      challengeId: 'nm-01-csaw18-getit',
      status: 'solved',
      notes: 'spoofed',
      pointsEarned: 500,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Terminal Solved State Downgrade / Points Inflation',
    actor: 'player',
    operation: 'update',
    path: '/progress/player_1_nm-01',
    payload: {
      status: 'in_progress',
      pointsEarned: 2000,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Forged Client Timestamp on Challenge Creation',
    actor: 'organizer',
    operation: 'create',
    path: '/challenges/forged-ts',
    payload: {
      id: 'forged-ts',
      createdAt: '2020-01-01T00:00:00Z',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'ID Poisoning & Oversized Payload Attack',
    actor: 'organizer',
    operation: 'create',
    path: `/challenges/${'A'.repeat(150)}`,
    payload: {
      id: 'A'.repeat(150),
      summary: 'X'.repeat(50000),
    },
    expected: 'PERMISSION_DENIED',
  },
];
