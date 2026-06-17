import type { MessageTemplate } from '@line-crm/db';

/**
 * LINE Messaging API message shape we send via push.
 * Subset to keep this module decoupled from the SDK.
 */
export type IntroMessage =
  | { type: 'text'; text: string }
  | { type: 'flex'; altText: string; contents: unknown };

/**
 * Default Flex sent when no intro template is configured.
 * Keep this generic because it is used as the last-resort fallback for
 * non-reward flows such as selection or onboarding checks.
 */
export function DEFAULT_FORM_LINK_FLEX(formUrl: string): IntroMessage {
  return {
    type: 'flex',
    altText: '確認事項の入力',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0F172A',
        paddingAll: '20px',
        contents: [
          {
            type: 'text',
            text: '確認事項の入力',
            weight: 'bold',
            size: 'lg',
            color: '#ffffff',
            align: 'center',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        contents: [
          {
            type: 'text',
            text: '下のボタンから必要事項の入力に進んでください',
            size: 'sm',
            color: '#666666',
            align: 'center',
            wrap: true,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          {
            type: 'button',
            action: { type: 'uri', label: '入力に進む', uri: formUrl },
            style: 'primary',
            color: '#06C755',
            height: 'md',
          },
        ],
      },
    },
  };
}

/**
 * Build the push message sent to a friend right after they join via a
 * tracked-link campaign. If a template is provided, substitute {formUrl}
 * placeholders with the actual LIFF form URL. Otherwise fall back to the
 * hardcoded default Flex.
 *
 * Substitution is a plain string replace performed BEFORE JSON.parse, so
 * placeholders work in any text/uri/string field of a Flex template
 * without needing tree traversal.
 */
export function buildIntroMessage(
  template: MessageTemplate | null,
  formUrl: string,
): IntroMessage {
  if (!template) return DEFAULT_FORM_LINK_FLEX(formUrl);

  // Defensive fallback: if a template never references {formUrl} and is not a
  // postback-driven Flex, sending it would leave the user with no way forward.
  if (!template.message_content.includes('{formUrl}') && !template.message_content.includes('"postback"')) {
    return DEFAULT_FORM_LINK_FLEX(formUrl);
  }

  const replaced = template.message_content.replaceAll('{formUrl}', formUrl);

  if (template.message_type === 'text') {
    return { type: 'text', text: replaced };
  }

  // flex — message_templates API only validates that content is JSON, not that
  // it conforms to LINE's Flex schema. If parsing fails (malformed save), fall
  // back to the default Flex so the user still sees a working form button
  // instead of pushMessage failing silently and leaving them with nothing.
  try {
    return {
      type: 'flex',
      altText: template.name,
      contents: JSON.parse(replaced),
    };
  } catch {
    return DEFAULT_FORM_LINK_FLEX(formUrl);
  }
}
