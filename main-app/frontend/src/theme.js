import { createTheme, rem } from '@mantine/core';

/**
 * Huong A: day, chu nho, chu mono.
 *
 * Ba can gat doc lap cung quyet dinh "do nho", dung nham lan nhau:
 *   scale        — thu nho TOAN BO (moi gia tri rem cua Mantine nhan voi so nay)
 *   fontSizes    — thang co chu rieng, doc lap voi scale
 *   defaultProps — size mac dinh cua tung component, dat mot lan o day
 *                  thay vi go size="xs" lai o hang tram cho trong code
 */
export const theme = createTheme({
  scale: 1,

  /**
   * Hai ho chu, chia theo NOI DUNG chu khong theo vi tri:
   *
   *   sans (Be Vietnam Pro) — moi cho co tieng Viet: nhan, tieu de, ghi chu.
   *   mono (JetBrains Mono) — chi du lieu: ten mien, gio, mili giay, ma trang thai.
   *
   * Ly do: chu don cach ep moi ky tu vao cung mot be rong, nen dau chong hai tang
   * cua tieng Viet (e-mu-sac, u-mo-nga) bi nen va dinh vao than chu — o co 11-13px
   * thi khong con doc duoc. Cac cot dung mono deu la ASCII thuan, khong co dau,
   * nen giu duoc loi the thang cot ma khong dinh nhuoc diem nao.
   */
  fontFamily:
    "'Be Vietnam Pro', 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
  fontFamilyMonospace:
    "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  headings: {
    fontFamily:
      "'Be Vietnam Pro', 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
    fontWeight: '600',
  },

  primaryColor: 'violet', // mau cua REDIRECT — thu ca he thong sinh ra de tim
  defaultRadius: 'sm',
  cursorType: 'pointer',
  autoContrast: true,

  // Co "medium": moi bac nhich len mot nac so voi ban day truoc do.
  // xs chi con dung cho chu phu (nhan mo, ghi chu), khong dung cho du lieu chinh.
  fontSizes: {
    xs: rem(12.5),
    sm: rem(13.5),
    md: rem(15),
    lg: rem(17),
    xl: rem(20),
  },
  lineHeights: {
    xs: '1.35',
    sm: '1.4',
    md: '1.45',
    lg: '1.5',
    xl: '1.5',
  },
  spacing: {
    xs: rem(8),
    sm: rem(11),
    md: rem(16),
    lg: rem(22),
    xl: rem(30),
  },

  components: {
    Button: { defaultProps: { size: 'md' } },
    ActionIcon: { defaultProps: { size: 'md', variant: 'subtle' } },
    TextInput: { defaultProps: { size: 'md' } },
    NumberInput: { defaultProps: { size: 'md' } },
    Select: { defaultProps: { size: 'md' } },
    Textarea: { defaultProps: { size: 'md' } },
    // tt:'none' — Mantine mac dinh viet hoa badge; tieng Viet viet hoa
    // co dau chong bi nen sat vien tren, doc cham han chu thuong.
    Badge: { defaultProps: { size: 'md', radius: 'sm', tt: 'none' } },
    Switch: { defaultProps: { size: 'sm' } },
    Loader: { defaultProps: { size: 'sm' } },
    Tooltip: { defaultProps: { fz: 'xs', withArrow: true, openDelay: 250 } },
    Paper: { defaultProps: { withBorder: true, radius: 'sm' } },
    Modal: { defaultProps: { radius: 'sm', centered: true } },
    Table: {
      defaultProps: {
        fz: 'sm',
        verticalSpacing: 'sm',
        horizontalSpacing: 'md',
        highlightOnHover: true,
        layout: 'auto',
      },
    },
  },
});
