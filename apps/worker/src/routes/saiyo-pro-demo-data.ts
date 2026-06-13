export type DemoCandidateProfile = {
  candidateId: string;
  fullName: string;
  kana: string;
  phone: string;
  availability: string;
  memo: string;
};

export type DemoCandidate = {
  id: string;
  name: string;
  job: string;
  color: string;
  status: string;
  lastMessage: string;
  lineUserId?: string;
  airworkProfile?: Omit<DemoCandidateProfile, 'candidateId'>;
};

export type DemoCompanySettings = {
  companyName: string;
  staffName: string;
  interviewUrl: string;
  interviewMessage: string;
};

export type DemoBannerPosition = 'center' | 'top' | 'bottom' | 'left' | 'right';

export type DemoCompanyJob = {
  companyName: string;
  title: string;
  hourlyWage: string;
  shift: string;
  description: string;
  bannerUrl: string;
  bannerPosition: DemoBannerPosition;
  bannerOffsetX: number;
  bannerOffsetY: number;
  bannerZoom: number;
};

export type DemoCandidateCompany = {
  id: string;
  name: string;
  reason: string;
  color: string;
  jobs: DemoCompanyJob[];
};

export type DemoCandidateStatus = {
  candidateId: string;
  status: 'active' | 'interview' | 'rejected' | 'archived';
  label: string;
};

export const DEMO_CANDIDATE_LINE_ACCOUNT_ID = 'saiyo-pro-candidate';
export const DEMO_COMPANY_LINE_ACCOUNT_ID = 'saiyo-pro-company';
export const DEMO_SERVICE_NAME = '採用PRO';
export const DEMO_COMPANY_NAME = 'Ikki Yamamoto 会社アカウント';
export const DEMO_TIMEREX_URL = 'https://timerex.net/';
export const DEMO_WORKER_URL = 'https://saiyo-pro-harness.ikki-y.workers.dev';
export const DEMO_CHAT_VERSION = '20260611a';
export const SAIYO_PRO_APPLICATION_START_IMAGE_URL = `${DEMO_WORKER_URL}/images/saiyo-pro/application-start-20260613.png`;
export const SAIYO_PRO_APPLICATION_COMPLETE_IMAGE_URL = `${DEMO_WORKER_URL}/images/saiyo-pro/application-complete-20260613.png`;
export const SAIYO_PRO_JOB_ARRIVED_IMAGE_URL = `${DEMO_WORKER_URL}/images/saiyo-pro/job-arrived-20260613.png`;
export const SAIYO_PRO_OFFICE_IMAGE_URL = `${DEMO_WORKER_URL}/images/saiyo-pro/office.png`;

export const DEMO_CANDIDATES: Record<string, DemoCandidate> = {
  yamada: {
    id: 'yamada',
    name: '山本 一気',
    job: '採用PRO 求人案内対象者',
    color: '#16A34A',
    status: '面接日程 調整中',
    lastMessage: '明日15時でお願いします。',
    airworkProfile: {
      fullName: '山本 一気',
      kana: 'やまもと いっき',
      phone: '090-1234-5678',
      availability: '週3日 / 平日夜と土日',
      memo: 'AirWork応募情報から作成した下書きです。',
    },
  },
  tokihara: {
    id: 'tokihara',
    name: '時原 陸',
    job: '採用PRO 求人案内対象者',
    color: '#0EA5E9',
    status: '応募受付',
    lastMessage: '応募ありがとうございます。詳細を確認中です。',
    lineUserId: 'U179d6ebbe2c4375ee170660a0f7e8ce7',
    airworkProfile: {
      fullName: '時原 陸',
      kana: 'ときはら りく',
      phone: '090-9876-5432',
      availability: '週4日 / 午後から夜',
      memo: 'AirWork応募情報から作成した下書きです。',
    },
  },
  sato: {
    id: 'sato',
    name: '佐藤 花子',
    job: '採用PRO 求人案内対象者',
    color: '#2563EB',
    status: '応募受付',
    lastMessage: '詳細を確認したいです。',
  },
  suzuki: {
    id: 'suzuki',
    name: '鈴木 健',
    job: '採用PRO 求人案内対象者',
    color: '#EA580C',
    status: '未対応',
    lastMessage: 'まだ返信していません。',
  },
};

export const DEFAULT_COMPANY_SETTINGS: DemoCompanySettings = {
  companyName: DEMO_COMPANY_NAME,
  staffName: '対応担当',
  interviewUrl: 'https://timerex.net/s/demo',
  interviewMessage: '面接日程のご調整をお願いします。以下のURLからご都合のよい日時を選んでください。',
};

export const DEFAULT_COMPANY_JOB: DemoCompanyJob = {
  companyName: DEMO_COMPANY_NAME,
  title: '未経験エンジニア / 正社員',
  hourlyWage: '面談時にご案内',
  shift: '週5日 / 配属先に準ずる',
  description: '研修後、ITインフラやシステム運用の業務を担当します。',
  bannerUrl: SAIYO_PRO_JOB_ARRIVED_IMAGE_URL,
  bannerPosition: 'center',
  bannerOffsetX: 0,
  bannerOffsetY: 0,
  bannerZoom: 1,
};

export const DEMO_CANDIDATE_COMPANIES: Record<string, DemoCandidateCompany> = {
  default: {
    id: 'default',
    name: DEMO_COMPANY_NAME,
    reason: '希望シフトに近く、接客経験を活かしやすい求人があります。',
    color: '#16A34A',
    jobs: [
      DEFAULT_COMPANY_JOB,
      {
        companyName: DEMO_COMPANY_NAME,
        title: 'ITサポート / 正社員',
        hourlyWage: '面談時にご案内',
        shift: '週5日 / 配属先に準ずる',
        description: 'ヘルプデスク、運用監視、問い合わせ対応などからスタートします。',
        bannerUrl: DEFAULT_COMPANY_JOB.bannerUrl,
        bannerPosition: 'center',
        bannerOffsetX: 0,
        bannerOffsetY: 0,
        bannerZoom: 1,
      },
    ],
  },
  sukiya: {
    id: 'sukiya',
    name: 'すき家 渋谷駅前店',
    reason: '夜シフトが多く、短時間から入りやすい求人です。',
    color: '#EA580C',
    jobs: [
      {
        companyName: 'すき家 渋谷駅前店',
        title: 'ホール・キッチンスタッフ',
        hourlyWage: '1,300円から / 深夜手当あり',
        shift: '週2日から / 夜シフト歓迎',
        description: '接客、配膳、簡単な調理、店内清掃を担当します。',
        bannerUrl: 'https://placehold.co/1024x520/EA580C/FFFFFF/png?text=Night+Shift',
        bannerPosition: 'center',
        bannerOffsetX: 0,
        bannerOffsetY: 0,
        bannerZoom: 1,
      },
    ],
  },
  veloce: {
    id: 'veloce',
    name: 'カフェ・ベローチェ 渋谷店',
    reason: '駅近で、朝から昼までの短時間勤務と相性が良さそうです。',
    color: '#7C3AED',
    jobs: [
      {
        companyName: 'カフェ・ベローチェ 渋谷店',
        title: 'カフェスタッフ',
        hourlyWage: '1,220円から / 交通費支給',
        shift: '朝7時から / 1日3時間から',
        description: 'レジ、ドリンク作成、フード提供、客席清掃を行います。',
        bannerUrl: 'https://placehold.co/1024x520/7C3AED/FFFFFF/png?text=Cafe+Staff',
        bannerPosition: 'center',
        bannerOffsetX: 0,
        bannerOffsetY: 0,
        bannerZoom: 1,
      },
    ],
  },
};

export function resolveSaiyoProDemoCandidateByLineUserId(lineUserId: string): DemoCandidate | null {
  return Object.values(DEMO_CANDIDATES).find((candidate) => candidate.lineUserId === lineUserId) ?? null;
}
