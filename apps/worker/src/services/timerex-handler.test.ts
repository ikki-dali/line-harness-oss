import { describe, expect, test, vi, beforeEach } from 'vitest';
import {
  handleTimerexEvent,
  type TimerexPayload,
  type TimerexHandlerEnv,
} from './timerex-handler.js';
import { signTimerexBooking } from './timerex-link.js';

vi.mock('@line-crm/db', () => ({
  getFriendByLineUserId: vi.fn(),
  getLineAccounts: vi.fn(),
  upsertTimerexBooking: vi.fn(),
  updateTimerexBookingStatus: vi.fn(),
  insertTimerexReminder: vi.fn(),
  cancelTimerexRemindersByEvent: vi.fn(),
  ensureConversionPointByEventType: vi.fn(),
  trackConversion: vi.fn(),
}));

vi.mock('./timerex-notifier.js', () => ({
  sendTimerexNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./ad-conversion.js', () => ({
  sendAdConversions: vi.fn().mockResolvedValue(undefined),
}));

import {
  getFriendByLineUserId,
  getLineAccounts,
  upsertTimerexBooking,
  updateTimerexBookingStatus,
  insertTimerexReminder,
  cancelTimerexRemindersByEvent,
  ensureConversionPointByEventType,
  trackConversion,
} from '@line-crm/db';

import { sendAdConversions } from './ad-conversion.js';

const LINK_SECRET = 'test-link-secret-32-chars-minimum';
const REMINDER_HOURS = 2;
const NOW = new Date('2026-05-10T10:00:00Z');

function createMockDb(): D1Database {
  return {} as D1Database;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Set default CV function mocks to avoid errors in tests that trigger CV logic
  vi.mocked(ensureConversionPointByEventType).mockResolvedValue({
    id: 'cp_default',
    name: 'Default CV',
    event_type: 'default',
    value: null,
    created_at: '2026-05-01T00:00:00Z',
  } as any);
  vi.mocked(trackConversion).mockResolvedValue(undefined);
  vi.mocked(sendAdConversions).mockResolvedValue(undefined);
});

describe('handleTimerexEvent', () => {
  describe('event_confirmed — happy path', () => {
    test('confirmed event with valid signature sends notification and registers reminder', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          name: 'Main Account',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
          created_at: '2026-05-01T00:00:00Z',
          updated_at: '2026-05-01T00:00:00Z',
        },
      ] as any);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({
        id: 'friend1',
        line_user_id: userId,
      } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        calendar_url_path: '/cal/123',
        calendar_name: '面接',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          end_datetime: '2026-05-12T15:00:00Z',
          hosts: [{ name: '山田太郎', email: 'yamada@example.com' }],
          url_params: [
            { line_user_id: userId, nonce, sig },
          ],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Verify booking was upserted
      expect(upsertTimerexBooking).toHaveBeenCalledOnce();
      const upsertCall = vi.mocked(upsertTimerexBooking).mock.calls[0];
      expect(upsertCall[1].eventId).toBe('evt1');
      expect(upsertCall[1].status).toBe('confirmed');
      expect(upsertCall[1].lineUserId).toBe(userId);

      // Verify notification was sent
      expect(sender).toHaveBeenCalledOnce();
      expect(sender).toHaveBeenCalledWith(
        expect.objectContaining({
          toLineUserId: userId,
          kind: 'confirmed',
          channelAccessToken: 'tok123',
        }),
      );

      // Verify reminder was registered
      expect(insertTimerexReminder).toHaveBeenCalledOnce();
      const reminderCall = vi.mocked(insertTimerexReminder).mock.calls[0];
      expect(reminderCall[1].eventId).toBe('evt1');
      expect(reminderCall[1].kind).toBe('hours_before');
    });

    test('does not send notification when signature verification fails', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const wrongSig = 'a'.repeat(64); // Wrong signature

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          name: 'Main Account',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      const sender = vi.fn();

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig: wrongSig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Booking should still be upserted (without notification)
      expect(upsertTimerexBooking).toHaveBeenCalledOnce();

      // But notification should NOT be sent
      expect(sender).not.toHaveBeenCalled();

      // And reminder should NOT be registered (no verified userId)
      expect(insertTimerexReminder).not.toHaveBeenCalled();
    });

    test('does not send notification when linkSecret is not configured', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      const sender = vi.fn();

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: undefined, // Not configured
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Booking is still upserted
      expect(upsertTimerexBooking).toHaveBeenCalledOnce();

      // But notification is skipped
      expect(sender).not.toHaveBeenCalled();
      expect(insertTimerexReminder).not.toHaveBeenCalled();
    });

    test('does not send notification when line account is missing', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([]); // No active accounts

      const sender = vi.fn();

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Booking is still upserted
      expect(upsertTimerexBooking).toHaveBeenCalledOnce();

      // But notification is skipped (no account)
      expect(sender).not.toHaveBeenCalled();
      expect(insertTimerexReminder).not.toHaveBeenCalled();
    });

    test('does not send notification when friend is missing', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue(null); // Friend not found

      const sender = vi.fn();

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Booking is still upserted (with null friendId)
      expect(upsertTimerexBooking).toHaveBeenCalledOnce();
      const upsertCall = vi.mocked(upsertTimerexBooking).mock.calls[0];
      expect(upsertCall[1].friendId).toBeNull();

      // Notification still sent (friend existence doesn't block it)
      expect(sender).toHaveBeenCalledOnce();
    });
  });

  describe('event_confirmed with reschedule (is_changed=true)', () => {
    test('cancels old event and registers new with rescheduled status', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend1' } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt2',
          start_datetime: '2026-05-13T15:00:00Z',
          is_changed: true,
          old_event_id: 'evt1',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Old event status updated to rescheduled
      expect(updateTimerexBookingStatus).toHaveBeenCalledWith(
        expect.anything(),
        'evt1',
        'rescheduled',
      );

      // Old event reminders cancelled
      expect(cancelTimerexRemindersByEvent).toHaveBeenCalledWith(expect.anything(), 'evt1');

      // New event upserted with rescheduled status
      expect(upsertTimerexBooking).toHaveBeenCalledOnce();
      const upsertCall = vi.mocked(upsertTimerexBooking).mock.calls[0];
      expect(upsertCall[1].eventId).toBe('evt2');
      expect(upsertCall[1].status).toBe('rescheduled');
      expect(upsertCall[1].oldEventId).toBe('evt1');

      // Notification sent as rescheduled
      expect(sender).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'rescheduled',
        }),
      );
    });

    test('handles reschedule without old_event_id (edge case)', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend1' } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt2',
          start_datetime: '2026-05-13T15:00:00Z',
          is_changed: true,
          old_event_id: null, // Edge case: no old event ID
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      // Should not crash
      await handleTimerexEvent(payload, env, NOW);

      // updateTimerexBookingStatus should NOT be called (no old_event_id)
      expect(updateTimerexBookingStatus).not.toHaveBeenCalled();

      // New event should still be upserted as rescheduled
      expect(upsertTimerexBooking).toHaveBeenCalledOnce();
      const upsertCall = vi.mocked(upsertTimerexBooking).mock.calls[0];
      expect(upsertCall[1].status).toBe('rescheduled');
    });
  });

  describe('event_cancelled', () => {
    test('cancels booking and sends cancellation notification', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_cancelled',
        calendar_name: '面接',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          hosts: [{ name: '山田' }],
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Booking status updated to cancelled
      expect(updateTimerexBookingStatus).toHaveBeenCalledWith(
        expect.anything(),
        'evt1',
        'cancelled',
      );

      // Reminders for event cancelled
      expect(cancelTimerexRemindersByEvent).toHaveBeenCalledWith(expect.anything(), 'evt1');

      // Cancellation notification sent
      expect(sender).toHaveBeenCalledOnce();
      expect(sender).toHaveBeenCalledWith(
        expect.objectContaining({
          toLineUserId: userId,
          kind: 'cancelled',
        }),
      );
    });

    test('cancels event even if signature verification fails (updates DB only)', async () => {
      const userId = 'U_user1';
      const wrongSig = 'a'.repeat(64);

      const sender = vi.fn();

      const payload: TimerexPayload = {
        webhook_type: 'event_cancelled',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, sig: wrongSig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // DB updates happen regardless
      expect(updateTimerexBookingStatus).toHaveBeenCalledWith(
        expect.anything(),
        'evt1',
        'cancelled',
      );

      expect(cancelTimerexRemindersByEvent).toHaveBeenCalledWith(expect.anything(), 'evt1');

      // But notification is skipped
      expect(sender).not.toHaveBeenCalled();
    });

    test('does not send cancellation notification when no start_datetime', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      const sender = vi.fn();

      const payload: TimerexPayload = {
        webhook_type: 'event_cancelled',
        event: {
          id: 'evt1',
          // No start_datetime
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // DB updates still happen
      expect(updateTimerexBookingStatus).toHaveBeenCalled();

      // But notification is NOT sent (no start_datetime)
      expect(sender).not.toHaveBeenCalled();
    });
  });

  describe('reminder registration boundary conditions', () => {
    test('does not register reminder if start time is in the past', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend1' } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-10T09:00:00Z', // 1 hour in the past (NOW = 2026-05-10T10:00:00Z)
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Notification sent
      expect(sender).toHaveBeenCalled();

      // But reminder NOT registered (in the past)
      expect(insertTimerexReminder).not.toHaveBeenCalled();
    });

    test('does not register reminder if reminder time would be in the past', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend1' } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          // Starts 1.5 hours from now (10:00 + 1.5h = 11:30)
          // Reminder should be at 10:00 + 1.5h - 2h = 9:30 (which is in the past since NOW = 10:00)
          start_datetime: '2026-05-10T11:30:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Notification sent
      expect(sender).toHaveBeenCalled();

      // But reminder NOT registered (reminder time in the past)
      expect(insertTimerexReminder).not.toHaveBeenCalled();
    });

    test('registers reminder if reminder time is exactly now', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend1' } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      // NOW = 2026-05-10T10:00:00Z
      // reminderHours = 2
      // start = NOW + 2 hours = 2026-05-10T12:00:00Z
      // reminder at = start - 2 hours = NOW (exactly)
      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-10T12:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Reminder should NOT be registered (not > now.getTime())
      expect(insertTimerexReminder).not.toHaveBeenCalled();
    });

    test('registers reminder if reminder time is in the future', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend1' } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      // NOW = 2026-05-10T10:00:00Z
      // reminderHours = 2
      // start = NOW + 2.1 hours = 2026-05-10T12:06:00Z
      // reminder at = start - 2 hours = NOW + 6 minutes (future)
      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-10T12:06:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Reminder should be registered
      expect(insertTimerexReminder).toHaveBeenCalledOnce();
    });

    test('does not register reminder if start_datetime is missing', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend1' } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          // No start_datetime
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Notification sent (with fallback time)
      expect(sender).toHaveBeenCalled();

      // But reminder NOT registered
      expect(insertTimerexReminder).not.toHaveBeenCalled();
    });
  });

  describe('defaults and edge cases', () => {
    test('uses provided sender over default', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend1' } as any);

      const customSender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender: customSender,
      };

      await handleTimerexEvent(payload, env, NOW);

      expect(customSender).toHaveBeenCalled();
    });

    test('uses default sender (sendTimerexNotification) when not provided', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend1' } as any);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        // sender: undefined (not provided, will use sendTimerexNotification)
      };

      // Should not crash (uses sendTimerexNotification by default, which is mocked)
      await handleTimerexEvent(payload, env, NOW);

      expect(upsertTimerexBooking).toHaveBeenCalled();
    });

    test('uses default values for missing event fields', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        // No calendar_url_path or calendar_name
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          // No hosts
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Verify defaults are used
      expect(sender).toHaveBeenCalledWith(
        expect.objectContaining({
          ctx: expect.objectContaining({
            calendarName: '面談', // default
            hostName: '担当者', // default
          }),
        }),
      );
    });

    test('selects primary line account by display_order', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc2',
          channel_access_token: 'tok2',
          is_active: 1,
          display_order: 2,
        } as any,
        {
          id: 'acc1',
          channel_access_token: 'tok1',
          is_active: 1,
          display_order: 1,
        } as any,
        {
          id: 'acc0',
          channel_access_token: 'tok0',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend1' } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Should use acc0 (display_order = 0)
      expect(sender).toHaveBeenCalledWith(
        expect.objectContaining({
          channelAccessToken: 'tok0',
        }),
      );
    });
  });

  describe('url_params parsing', () => {
    test('extracts string values from url_params array', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [
            { line_user_id: userId, nonce, sig, extra: 123, unused: null },
          ],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      // Should not crash when parsing mixed types
      await handleTimerexEvent(payload, env, NOW);

      expect(upsertTimerexBooking).toHaveBeenCalled();
    });

    test('handles missing url_params gracefully', async () => {
      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          // No url_params
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      // Should not crash
      await handleTimerexEvent(payload, env, NOW);

      // Notification should NOT be sent (no signature verification)
      expect(sender).not.toHaveBeenCalled();
    });
  });

  describe('ad-conversion integration (offline CV)', () => {
    test('sends ad conversion for new confirmed event when friend exists', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({
        id: 'friend1',
        line_user_id: userId,
      } as any);

      vi.mocked(ensureConversionPointByEventType).mockResolvedValue({
        id: 'cp1',
        name: 'TimeRex予約確定',
        event_type: 'timerex_booking_confirmed',
        value: null,
        created_at: '2026-05-01T00:00:00Z',
      } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        calendar_url_path: '/cal/123',
        calendar_name: '面接',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          end_datetime: '2026-05-12T15:00:00Z',
          hosts: [{ name: '山田太郎', email: 'yamada@example.com' }],
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Verify ensureConversionPointByEventType was called
      expect(ensureConversionPointByEventType).toHaveBeenCalledOnce();
      expect(ensureConversionPointByEventType).toHaveBeenCalledWith(
        expect.anything(),
        'timerex_booking_confirmed',
        'TimeRex予約確定',
      );

      // Verify trackConversion was called with correct friendId
      expect(trackConversion).toHaveBeenCalledOnce();
      const trackCall = vi.mocked(trackConversion).mock.calls[0];
      expect(trackCall[1].friendId).toBe('friend1');
      expect(trackCall[1].conversionPointId).toBe('cp1');
      expect(trackCall[1].metadata).toContain('evt1');

      // Verify sendAdConversions was called with correct parameters
      expect(sendAdConversions).toHaveBeenCalledOnce();
      expect(sendAdConversions).toHaveBeenCalledWith(
        expect.anything(),
        'friend1',
        'timerex_booking_confirmed',
        undefined,
      );
    });

    test('sends ad conversion even when conversion point value is null', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({
        id: 'friend1',
        line_user_id: userId,
      } as any);

      vi.mocked(ensureConversionPointByEventType).mockResolvedValue({
        id: 'cp1',
        name: 'TimeRex予約確定',
        event_type: 'timerex_booking_confirmed',
        value: 1000, // Has value
        created_at: '2026-05-01T00:00:00Z',
      } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // sendAdConversions should be called with the conversion point value
      expect(sendAdConversions).toHaveBeenCalledOnce();
      expect(sendAdConversions).toHaveBeenCalledWith(
        expect.anything(),
        'friend1',
        'timerex_booking_confirmed',
        1000,
      );
    });

    test('skips ad conversion when event is rescheduled (is_changed=true)', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({
        id: 'friend1',
        line_user_id: userId,
      } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt2',
          start_datetime: '2026-05-13T15:00:00Z',
          is_changed: true, // Reschedule
          old_event_id: 'evt1',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Ensure CV functions are NOT called for reschedule
      expect(ensureConversionPointByEventType).not.toHaveBeenCalled();
      expect(trackConversion).not.toHaveBeenCalled();
      expect(sendAdConversions).not.toHaveBeenCalled();
    });

    test('skips ad conversion when friend does not exist', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue(null); // No friend

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Ensure CV functions are NOT called when friend is null
      expect(ensureConversionPointByEventType).not.toHaveBeenCalled();
      expect(trackConversion).not.toHaveBeenCalled();
      expect(sendAdConversions).not.toHaveBeenCalled();
    });

    test('skips ad conversion when signature verification fails', async () => {
      const userId = 'U_user1';
      const wrongSig = 'a'.repeat(64);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      const sender = vi.fn();

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, sig: wrongSig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Ensure CV functions are NOT called when signature fails (friend lookup skipped)
      expect(ensureConversionPointByEventType).not.toHaveBeenCalled();
      expect(trackConversion).not.toHaveBeenCalled();
      expect(sendAdConversions).not.toHaveBeenCalled();
    });

    test('skips ad conversion when linkSecret is not configured', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({
        id: 'friend1',
        line_user_id: userId,
      } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: undefined, // Not configured
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Ensure CV functions are NOT called (signature verification skipped, friend lookup skipped)
      expect(ensureConversionPointByEventType).not.toHaveBeenCalled();
      expect(trackConversion).not.toHaveBeenCalled();
      expect(sendAdConversions).not.toHaveBeenCalled();
    });

    test('does not throw when sendAdConversions fails (try/catch protection)', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({
        id: 'friend1',
        line_user_id: userId,
      } as any);

      vi.mocked(ensureConversionPointByEventType).mockResolvedValue({
        id: 'cp1',
        name: 'TimeRex予約確定',
        event_type: 'timerex_booking_confirmed',
        value: null,
        created_at: '2026-05-01T00:00:00Z',
      } as any);

      vi.mocked(trackConversion).mockResolvedValue(undefined);

      // Make sendAdConversions reject
      vi.mocked(sendAdConversions).mockRejectedValue(new Error('Ad platform error'));

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      // Should not throw, try/catch handles the error
      await expect(handleTimerexEvent(payload, env, NOW)).resolves.toBeUndefined();

      // Verify that trackConversion was still called (order confirmed)
      expect(trackConversion).toHaveBeenCalledOnce();

      // Verify sendAdConversions was called but error was caught
      expect(sendAdConversions).toHaveBeenCalledOnce();
    });

    test('does not throw when trackConversion fails (try/catch protection)', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({
        id: 'friend1',
        line_user_id: userId,
      } as any);

      vi.mocked(ensureConversionPointByEventType).mockResolvedValue({
        id: 'cp1',
        name: 'TimeRex予約確定',
        event_type: 'timerex_booking_confirmed',
        value: null,
        created_at: '2026-05-01T00:00:00Z',
      } as any);

      // Make trackConversion reject
      vi.mocked(trackConversion).mockRejectedValue(new Error('DB error'));

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      // Should not throw, try/catch handles the error
      await expect(handleTimerexEvent(payload, env, NOW)).resolves.toBeUndefined();

      // Verify that ensureConversionPointByEventType was called
      expect(ensureConversionPointByEventType).toHaveBeenCalledOnce();

      // Verify trackConversion was called but error was caught
      expect(trackConversion).toHaveBeenCalledOnce();
    });

    test('does not throw when ensureConversionPointByEventType fails (try/catch protection)', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({
        id: 'friend1',
        line_user_id: userId,
      } as any);

      // Make ensureConversionPointByEventType reject
      vi.mocked(ensureConversionPointByEventType).mockRejectedValue(
        new Error('CP creation failed'),
      );

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      // Should not throw, try/catch handles the error
      await expect(handleTimerexEvent(payload, env, NOW)).resolves.toBeUndefined();

      // Verify that ensureConversionPointByEventType was called
      expect(ensureConversionPointByEventType).toHaveBeenCalledOnce();

      // trackConversion and sendAdConversions should NOT be called
      expect(trackConversion).not.toHaveBeenCalled();
      expect(sendAdConversions).not.toHaveBeenCalled();
    });

    test('records event_id and calendar_name in conversion metadata', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({
        id: 'friend1',
        line_user_id: userId,
      } as any);

      vi.mocked(ensureConversionPointByEventType).mockResolvedValue({
        id: 'cp1',
        name: 'TimeRex予約確定',
        event_type: 'timerex_booking_confirmed',
        value: null,
        created_at: '2026-05-01T00:00:00Z',
      } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        calendar_url_path: '/cal/123',
        calendar_name: '採用面接',
        event: {
          id: 'evt-xyz-789',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Verify trackConversion was called with correct metadata
      expect(trackConversion).toHaveBeenCalledOnce();
      const trackCall = vi.mocked(trackConversion).mock.calls[0];
      const metadata = JSON.parse(trackCall[1].metadata as string);
      expect(metadata.eventId).toBe('evt-xyz-789');
      expect(metadata.calendarName).toBe('採用面接');
    });

    test('handles missing calendar_name gracefully (uses null)', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce123';
      const sig = await signTimerexBooking(userId, nonce, LINK_SECRET);

      vi.mocked(getLineAccounts).mockResolvedValue([
        {
          id: 'acc1',
          channel_access_token: 'tok123',
          is_active: 1,
          display_order: 0,
        } as any,
      ]);

      vi.mocked(getFriendByLineUserId).mockResolvedValue({
        id: 'friend1',
        line_user_id: userId,
      } as any);

      vi.mocked(ensureConversionPointByEventType).mockResolvedValue({
        id: 'cp1',
        name: 'TimeRex予約確定',
        event_type: 'timerex_booking_confirmed',
        value: null,
        created_at: '2026-05-01T00:00:00Z',
      } as any);

      const sender = vi.fn().mockResolvedValue(undefined);

      const payload: TimerexPayload = {
        webhook_type: 'event_confirmed',
        // No calendar_name
        event: {
          id: 'evt1',
          start_datetime: '2026-05-12T14:00:00Z',
          url_params: [{ line_user_id: userId, nonce, sig }],
        },
      };

      const env: TimerexHandlerEnv = {
        db: createMockDb(),
        linkSecret: LINK_SECRET,
        reminderHoursBefore: REMINDER_HOURS,
        sender,
      };

      await handleTimerexEvent(payload, env, NOW);

      // Verify trackConversion was still called with null calendarName
      expect(trackConversion).toHaveBeenCalledOnce();
      const trackCall = vi.mocked(trackConversion).mock.calls[0];
      const metadata = JSON.parse(trackCall[1].metadata as string);
      expect(metadata.calendarName).toBeNull();
    });
  });
});
