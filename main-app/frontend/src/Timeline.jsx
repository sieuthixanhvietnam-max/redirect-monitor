import * as React from 'react';
import {
  Badge, Box, Group, Paper, SegmentedControl, Stack, Text, Tooltip,
} from '@mantine/core';
import { ArrowRightIcon, ClockIcon, InfoIcon } from '@phosphor-icons/react';
import { CHANGE_KIND, fmtUnc, fmtVN, hostOf, REDIRECT_KINDS } from './lib';

const VN_TZ = 'Asia/Ho_Chi_Minh';

const partsVN = (iso) =>
  new Intl.DateTimeFormat('vi-VN', {
    timeZone: VN_TZ, hour12: false,
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(iso)).reduce((a, p) => ((a[p.type] = p.value), a), {});

const dayKey = (iso) => {
  const p = partsVN(iso);
  return `${p.year}-${p.month}-${p.day}`;
};

/** "Hom nay" / "Hom qua" doc nhanh hon mot ngay thang tuyet doi khi luot. */
function dayTitle(iso) {
  const p = partsVN(iso);
  const today = dayKey(new Date().toISOString());
  const yest = dayKey(new Date(Date.now() - 86400e3).toISOString());
  const k = dayKey(iso);
  const abs = `${p.day}/${p.month}/${p.year}`;
  if (k === today) return { main: 'Hôm nay', sub: abs };
  if (k === yest) return { main: 'Hôm qua', sub: abs };
  return { main: p.weekday, sub: abs };
}

const hhmm = (iso) => {
  const p = partsVN(iso);
  return `${p.hour}:${p.minute}`;
};

function side(s) {
  if (!s) return '—';
  const code = s.status_code ?? '—';
  return s.target_url ? `${code} → ${hostOf(s.target_url)}` : `${code} · không chuyển hướng`;
}

/**
 * Mot su kien tren duong thoi gian.
 *
 * Thoi diem duoc trinh bay nhu mot KHOANG chu khong phai mot moc: he thong kiem
 * tra theo chu ky nen khong the biet 301 xay ra dung giay nao. Ve mot moc don le
 * la noi doi, nen sai so luon di kem ngay ben canh.
 */
export function ChangeRow({ c, compact, last }) {
  const [label, color] = CHANGE_KIND[c.change_kind] || [c.change_kind, 'gray'];
  const wide = c.uncertainty_sec > 600;
  // Moc goc, khong phai mot thay doi: khong co trang thai truoc do de so sanh,
  // va cua so bat dinh bang 0 nen hien sai so chi la nhieu.
  const first = c.change_kind === 'first_seen';

  return (
    <Box className={`tl-item${last ? ' tl-last' : ''}`} pb={compact ? 'sm' : 'md'}>
      <span className="tl-dot" style={{ background: `var(--mantine-color-${color}-6)` }} />

      <Group gap="xs" wrap="wrap" align="center">
        <Text size="sm" ff="monospace" fw={600} style={{ minWidth: 42 }}>
          {hhmm(c.created_at)}
        </Text>
        <Badge color={color} variant="light">{label}</Badge>
        {!compact && <Text size="sm" fw={600} ff="monospace">{hostOf(c.url)}</Text>}
      </Group>

      {first ? (
        <Group gap={7} wrap="wrap" align="center" mt={5}>
          <Text size="sm" c="dimmed">Tình trạng lúc bắt đầu:</Text>
          <Text size="sm" fw={600} ff="monospace">{side(c.to_state)}</Text>
        </Group>
      ) : (
        <Group gap={7} wrap="wrap" align="center" mt={5}>
          <Text size="sm" c="dimmed" ff="monospace">{side(c.from_state)}</Text>
          <ArrowRightIcon size={12} opacity={0.45} />
          <Text size="sm" fw={600} ff="monospace">{side(c.to_state)}</Text>
        </Group>
      )}

      {!first && (
      <Group gap={6} wrap="wrap" align="center" mt={4}>
        <ClockIcon size={12} opacity={0.45} />
        <Text size="xs" c="dimmed">
          Xảy ra đâu đó trong khoảng {fmtVN(c.window_start)} → {fmtVN(c.window_end)}
        </Text>
        <Tooltip
          multiline w={330}
          label={
            wide
              ? 'Khoảng rộng bất thường: hệ thống mất dấu trong quãng đó (proxy hỏng hoặc máy tắt), nên chỉ biết thay đổi rơi vào đâu đó ở giữa. Không có nghĩa sự kiện kéo dài từng ấy lâu.'
              : 'Hệ thống kiểm tra theo chu kỳ nên không biết chính xác từng giây. Độ rộng khoảng xấp xỉ nhịp kiểm tra.'
          }
        >
          <Badge
            color={wide ? 'orange' : 'gray'}
            variant={wide ? 'light' : 'default'}
            leftSection={wide ? <InfoIcon size={10} /> : null}
          >
            {fmtUnc(c.uncertainty_sec)}
          </Badge>
        </Tooltip>
      </Group>
      )}
    </Box>
  );
}

export default function Timeline({ changes }) {
  const [scope, setScope] = React.useState('quan-trong');

  // Phan lon ban ghi that la thay doi phu (duong di xe dich nhung noi den thi
  // khong). De lan lon thi vai su kien dang quan tam bi hang chuc dong phu de mat.
  const important = React.useMemo(
    () =>
      changes.filter(
        (c) => REDIRECT_KINDS.has(c.change_kind) || c.change_kind === 'first_seen'
      ),
    [changes]
  );
  const shown = scope === 'tat-ca' ? changes : important;
  const hidden = changes.length - important.length;

  const groups = React.useMemo(() => {
    const out = [];
    for (const c of shown) {
      const k = dayKey(c.created_at);
      const lastG = out[out.length - 1];
      if (lastG && lastG.key === k) lastG.items.push(c);
      else out.push({ key: k, title: dayTitle(c.created_at), items: [c] });
    }
    return out;
  }, [shown]);

  if (!changes.length)
    return (
      <Paper p="xl">
        <Box ta="center" py="xl">
          <Text fw={600} size="lg">Chưa ghi nhận thay đổi nào</Text>
          <Text size="sm" c="dimmed" mt={6} maw={560} mx="auto">
            Khi một domain bắt đầu chuyển hướng, đổi nơi đến, hoặc thôi không chuyển nữa,
            nó sẽ xuất hiện ở đây kèm thời điểm và sai số.
          </Text>
        </Box>
      </Paper>
    );

  return (
    <Box>
      <Paper p="sm" mb="md">
        <Group gap="sm" wrap="wrap">
          <SegmentedControl
            size="xs"
            value={scope}
            onChange={setScope}
            data={[
              { value: 'quan-trong', label: `Thay đổi quan trọng (${important.length})` },
              { value: 'tat-ca', label: `Tất cả (${changes.length})` },
            ]}
          />
          <Box style={{ flex: 1 }} />
          {scope === 'quan-trong' && hidden > 0 && (
            <Text size="sm" c="dimmed">
              Đang ẩn {hidden} thay đổi nhỏ — đường đi có xê dịch nhưng nơi đến vẫn thế
            </Text>
          )}
        </Group>
      </Paper>

      {!shown.length ? (
        <Paper p="xl">
          <Text size="sm" c="dimmed" ta="center">
            Không có thay đổi quan trọng nào. Toàn bộ {changes.length} bản ghi đều là
            xê dịch nhỏ, nơi đến không đổi.
          </Text>
        </Paper>
      ) : (
        <Stack gap="md">
          {groups.map((g) => (
            <Paper key={g.key} p="md">
              <Group gap="xs" align="baseline" mb="sm">
                <Text size="sm" fw={700} tt="capitalize">{g.title.main}</Text>
                <Text size="sm" c="dimmed">{g.title.sub}</Text>
                <Box style={{ flex: 1 }} />
                <Badge variant="default">{g.items.length} thay đổi</Badge>
              </Group>

              {g.items.map((c, i) => (
                <ChangeRow key={c.id} c={c} last={i === g.items.length - 1} />
              ))}
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
}
