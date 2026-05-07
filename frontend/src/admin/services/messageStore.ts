import type { Message, MessageStatus, AssignedTo } from '@admin/types/messages';

// Shared localStorage-backed store for the admin Messages UI. Mirrors the
// sponsorStore pattern (CLAUDE.md gotcha: first-read materializes seed so
// subsequent operations against actual storage don't silently wipe the seed).
//
// When the backend Message model + endpoints land (future), swap the
// persistence layer here without touching pages/components.

const STORE_KEY = 'circuits.admin.messages';

// 15 sample messages — ported verbatim from the Claude Design handoff
// (ui_kits/admin/messages.jsx) so the demo data matches the design intent.
export const SEED_MESSAGES: Message[] = [
  {
    id: '0d2e8f',
    seq: 47,
    type: 'join',
    status: 'new',
    spam_score: 0.02,
    created_at: '2026-05-07T14:32:11Z',
    payload: {
      company_name: 'Arrow Electronics',
      contact_person: 'Jane Buyer',
      email: 'jane.buyer@arrow.com',
      phone: '631-555-0143',
      website: 'arrow.com',
      categories_of_interest: ['Resistors', 'Capacitors', 'ICs', 'Connectors'],
      tier: 'platinum',
      message:
        "We'd like to list our full distribution catalog with priority placement on top categories. Open to discussion on tier flexibility — Q3 budget is allocated and we'd prefer to move quickly.",
    },
  },
  {
    id: '8b1c44',
    seq: 46,
    type: 'contact',
    status: 'new',
    spam_score: 0.01,
    created_at: '2026-05-07T11:08:55Z',
    payload: {
      name: 'Tom Reilly',
      email: 't.reilly@gizmodo.com',
      reason: 'press',
      subject: 'Press inquiry — directory comparison piece',
      message:
        'Working on a piece comparing electronic-component directories (Octopart, Findchips, etc.) and would love 15 min with John or Mike. Deadline next Friday — happy to send questions in advance.\n\nCovering coverage breadth, search quality, and the ad model. — Tom',
    },
  },
  {
    id: 'a91244',
    seq: 45,
    type: 'keyword',
    status: 'new',
    spam_score: 0.04,
    created_at: '2026-05-07T09:51:02Z',
    payload: {
      company_name: 'Linear Tech / ADI',
      email: 'partners@analog.com',
      keyword: 'low-noise op-amps',
      message:
        'Interested in keyword sponsorship for our LT-series. 12-month commit OK, would like to discuss exclusivity.',
    },
  },
  {
    id: '4f7a18',
    seq: 44,
    type: 'contact',
    status: 'read',
    spam_score: 0.02,
    created_at: '2026-05-07T08:14:33Z',
    read_at: '2026-05-07T08:22:01Z',
    assigned_to: 'mike',
    payload: {
      name: 'Sandra Park',
      email: 's.park@nuvoton.com',
      reason: 'list',
      subject: 'How do I add a part?',
      message:
        "Hi — I'm a product engineer at Nuvoton and noticed our newer N32 series isn't showing up. What's the path to get a new MCU family added to your catalog?",
    },
  },
  {
    id: 'b22091',
    seq: 43,
    type: 'join',
    status: 'read',
    created_at: '2026-05-06T22:47:19Z',
    read_at: '2026-05-07T07:02:48Z',
    payload: {
      company_name: 'Future Electronics',
      contact_person: 'Marc Hébert',
      email: 'm.hebert@futureelectronics.com',
      phone: '514-555-2810',
      website: 'futureelectronics.com',
      categories_of_interest: ['Memory ICs', 'Power Management', 'RF & Wireless'],
      tier: 'gold',
      message: 'Renewing for another 12 months. Same categories. Please bill the existing PO.',
    },
  },
  {
    id: 'f23ab9',
    seq: 42,
    type: 'keyword',
    status: 'responded',
    created_at: '2026-05-06T16:44:01Z',
    read_at: '2026-05-06T16:50:13Z',
    responded_at: '2026-05-06T17:02:47Z',
    assigned_to: 'john',
    payload: {
      company_name: 'Vishay Intertechnology',
      email: 'partnerships@vishay.com',
      keyword: 'low-noise op-amps',
      message: 'Interested in keyword sponsorship for our LNA-series. 12-month commit OK.',
    },
  },
  {
    id: 'c5d810',
    seq: 41,
    type: 'contact',
    status: 'read',
    created_at: '2026-05-06T13:22:50Z',
    read_at: '2026-05-06T13:55:11Z',
    assigned_to: 'john',
    payload: {
      name: 'Karim Othman',
      email: 'k.othman@octopart.com',
      reason: 'data',
      subject: 'Datasheet feed cooperation',
      message:
        'We maintain a normalized datasheet index and could swap reciprocal links if useful. Open to a chat?',
    },
  },
  {
    id: 'd09812',
    seq: 40,
    type: 'join',
    status: 'responded',
    created_at: '2026-05-06T10:11:09Z',
    read_at: '2026-05-06T10:18:00Z',
    responded_at: '2026-05-06T11:30:04Z',
    assigned_to: 'mike',
    payload: {
      company_name: 'TTI Inc',
      contact_person: 'Roger Bell',
      email: 'r.bell@ttiinc.com',
      phone: '817-555-0903',
      website: 'ttiinc.com',
      categories_of_interest: ['Connectors', 'Relays', 'Switches'],
      tier: 'silver',
      message: 'Trial run on connectors first; will scale tier if it pans out.',
    },
  },
  {
    id: 'cc8847',
    seq: 39,
    type: 'contact',
    status: 'archived',
    spam_score: 0.94,
    created_at: '2026-05-06T03:21:09Z',
    payload: {
      name: 'asdfasdf',
      email: 'qwerty1234@throwaway.email',
      reason: 'other',
      subject: 'aaaaaaa',
      message: 'click here for free crypto crypto crypto !!! CLICK NOW',
    },
  },
  {
    id: 'e44e10',
    seq: 38,
    type: 'contact',
    status: 'archived',
    created_at: '2026-05-05T19:02:14Z',
    read_at: '2026-05-05T19:08:00Z',
    responded_at: '2026-05-05T19:31:44Z',
    assigned_to: 'john',
    payload: {
      name: 'Helena Wu',
      email: 'helena@quanta.com',
      reason: 'general',
      subject: 'Bug — search returns nothing for "STM32F4"',
      message:
        'Search bar empty results for STM32F4 family. Repro on Chrome 124. Fyi.',
    },
  },
  {
    id: '7b3c20',
    seq: 37,
    type: 'keyword',
    status: 'read',
    created_at: '2026-05-05T11:18:02Z',
    read_at: '2026-05-05T13:00:01Z',
    payload: {
      company_name: 'Macronix',
      email: 'partners@macronix.com',
      keyword: 'spi nor flash',
      message:
        'Sponsoring this keyword across our 64Mb-256Mb SPI NOR family. Exclusive preferred.',
    },
  },
  {
    id: '11dd09',
    seq: 36,
    type: 'contact',
    status: 'new',
    spam_score: 0.78,
    created_at: '2026-05-05T05:44:33Z',
    payload: {
      name: 'maria_v',
      email: 'maria.v@unknownmail.org',
      reason: 'other',
      subject: 'partnership opportunity for your business',
      message:
        'Hello dear, we have great opportunity to make 10x revenue. Please reply with phone number to discuss.',
    },
  },
  {
    id: '6a8210',
    seq: 35,
    type: 'contact',
    status: 'responded',
    created_at: '2026-05-02T15:31:11Z',
    read_at: '2026-05-02T16:02:00Z',
    responded_at: '2026-05-02T17:18:00Z',
    assigned_to: 'mike',
    payload: {
      name: 'Dr. Robin Engel',
      email: 'engel@uw.edu',
      reason: 'general',
      subject: 'Academic licensing of catalog metadata',
      message:
        'Working on a supply-chain resilience paper. Would love read-only API access for ~3 months.',
    },
  },
  {
    id: '00aa44',
    seq: 34,
    type: 'join',
    status: 'responded',
    created_at: '2026-05-01T09:00:14Z',
    read_at: '2026-05-01T09:11:00Z',
    responded_at: '2026-05-01T15:00:00Z',
    assigned_to: 'john',
    payload: {
      company_name: 'Mouser Electronics',
      contact_person: 'Lacy Ng',
      email: 'lacy.ng@mouser.com',
      phone: '817-555-1144',
      website: 'mouser.com',
      categories_of_interest: [
        'Microcontrollers',
        'Memory ICs',
        'Sensor ICs',
        'Analog ICs',
        'Interface ICs',
      ],
      tier: 'platinum',
      message: 'Q3 push — full catalog refresh, priority on automotive-grade.',
    },
  },
  {
    id: '9c7711',
    seq: 33,
    type: 'keyword',
    status: 'archived',
    created_at: '2026-04-29T18:17:02Z',
    read_at: '2026-04-29T19:02:00Z',
    payload: {
      company_name: 'TDK',
      email: 'partners@tdk.com',
      keyword: 'mlcc',
      message: 'Window 6 months, scope global.',
    },
  },
];

function writeRaw(rows: Message[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(rows));
  } catch {
    /* localStorage unavailable / full — non-fatal for the demo */
  }
}

export function loadMessages(): Message[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Message[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('[messageStore] corrupt data, re-seeding', err);
  }
  // First read: materialize seed so subsequent operations operate against
  // actual storage. Without this, archive/spam on a seed message would write
  // [] and the entire seed list would silently disappear (sponsorStore lesson).
  writeRaw(SEED_MESSAGES);
  return SEED_MESSAGES;
}

export function findMessage(id: string): Message | undefined {
  return loadMessages().find((m) => m.id === id);
}

function patch(id: string, fn: (m: Message) => Message): void {
  writeRaw(loadMessages().map((m) => (m.id === id ? fn(m) : m)));
}

export function markRead(id: string): void {
  patch(id, (m) =>
    m.status === 'new'
      ? { ...m, status: 'read', read_at: new Date().toISOString() }
      : m,
  );
}

export function toggleRead(id: string): void {
  patch(id, (m) => {
    if (m.status === 'new') {
      return { ...m, status: 'read', read_at: new Date().toISOString() };
    }
    if (m.status === 'read' || m.status === 'responded') {
      return { ...m, status: 'new', read_at: undefined };
    }
    return m;
  });
}

export function archive(id: string): void {
  patch(id, (m) => ({ ...m, status: 'archived' }));
}

export function markSpam(id: string): void {
  patch(id, (m) => ({
    ...m,
    status: 'archived',
    spam_score: Math.max(m.spam_score ?? 0, 0.85),
  }));
}

export function assignTo(id: string, who: AssignedTo): void {
  patch(id, (m) => ({ ...m, assigned_to: who }));
}

export function recordReply(id: string, body: string): void {
  patch(id, (m) => ({
    ...m,
    status: 'responded' satisfies MessageStatus,
    responded_at: new Date().toISOString(),
    last_reply_body: body,
  }));
}

export function unreadCount(): number {
  return loadMessages().filter((m) => m.status === 'new').length;
}

export function recentUnread(limit = 5): Message[] {
  return loadMessages()
    .filter((m) => m.status === 'new')
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
    .slice(0, limit);
}
