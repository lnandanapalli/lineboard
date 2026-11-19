/**
 * Browser storage every test starts with: the one-time storage notice already dismissed, and the
 * board in strips mode (most tests are written against strips; new users get split mode, which
 * tests/split.spec.ts and the first-visit tests cover with empty storage).
 */
const USER_ID = '11111111-1111-4111-8111-111111111111'; // = mockSupabase USER_ID
const strips = JSON.stringify({ mode: 'strips' });

export const TEST_STORAGE = {
  cookies: [],
  origins: [
    {
      origin: 'http://localhost:4173',
      localStorage: [
        { name: 'lb-storage-notice', value: 'true' },
        { name: 'lb-settings-local', value: strips },
        { name: `lb-settings-${USER_ID}`, value: strips },
      ],
    },
  ],
};
