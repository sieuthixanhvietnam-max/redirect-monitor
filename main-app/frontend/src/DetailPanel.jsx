import * as React from 'react';
import {
  Badge, Box, Button, Divider, Group, Loader, Modal, Paper, ScrollArea, Stack, Text, Tooltip,
} from '@mantine/core';
import {
  ArrowClockwiseIcon, ArrowDownIcon, TrashIcon,
} from '@phosphor-icons/react';
import {
  ago, api, BLOCK_KIND, domainState, fmtMs, fmtVN, hostOf, isSlow, MODE, modeLabel,
} from './lib';
import Activity, { ActivityLegend } from './Activity';
import { ChangeRow } from './Timeline';

function Section({ title, right, children }) {
  return (
    <Box mt="lg">
      <Group gap="xs" mb={6}>
        <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '.07em' }}>
          {title}
        </Text>
        <Box style={{ flex: 1, height: 1, background: 'var(--mantine-color-default-border)' }} />
        {right}
      </Group>
      {children}
    </Box>
  );
}

/** Mot cap nhan - gia tri. Nhan co be rong co dinh de mat quet duoc theo cot. */
function Fact({ label, children }) {
  return (
    <Group gap="sm" wrap="nowrap" align="baseline">
      <Text size="sm" c="dimmed" style={{ minWidth: 172, flex: 'none' }}>
        {label}
      </Text>
      <Text size="sm">{children}</Text>
    </Group>
  );
}

const statusColor = (s) =>
  s == null ? 'gray' : s >= 500 ? 'red' : s >= 400 ? 'orange' : s >= 300 ? 'violet' : 'teal';

/** Chuoi hop theo chieu doc: moi hop mot dong, mui ten noi xuong hop sau. */
function Chain({ chain }) {
  if (!chain?.length) return <Text size="sm" c="dimmed">Chưa có dữ liệu đường đi.</Text>;
  return (
    <Paper p="sm">
      {chain.map((h, i) => (
        <Box key={i}>
          <Group gap="xs" wrap="nowrap" align="flex-start">
            <Badge color={statusColor(h.status)} variant="light" size="xs">
              {h.status ?? '?'}
            </Badge>
            <Text size="sm" ff="monospace" className="break-all">{h.url}</Text>
            {h.type && h.type !== 'http' && (
              <Badge variant="default" size="xs">{h.type}</Badge>
            )}
          </Group>
          {i < chain.length - 1 && (
            <ArrowDownIcon size={12} opacity={0.4} style={{ margin: '3px 0 3px 6px' }} />
          )}
        </Box>
      ))}
    </Paper>
  );
}

export default function DetailPanel({ id, bars, onClose, onChanged, onDelete }) {
  const [data, setData] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!id) return;
    try {
      setData(await api(`/api/domains/${id}`));
    } catch {
      setData(null);
    }
  }, [id]);

  React.useEffect(() => {
    setData(null);
    load();
  }, [id, load]);

  const check = async () => {
    setBusy(true);
    try {
      await api(`/api/domains/${id}/check`, { method: 'POST' });
      await load();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const d = data?.domain;
  const st = d ? domainState(d) : null;

  return (
    <Modal
      opened={!!id}
      onClose={onClose}
      size="xl"
      scrollAreaComponent={ScrollArea.Autosize}
      title={
        d ? (
          <Group gap="xs">
            <Text fw={700} size="md" ff="monospace">{hostOf(d.url)}</Text>
            {d.label && <Badge variant="default" size="xs">{d.label}</Badge>}
          </Group>
        ) : 'Đang tải…'
      }
    >
      {!d ? (
        <Group justify="center" py="xl"><Loader /></Group>
      ) : (
        <Box>
          <Group gap="xs" wrap="wrap">
            <Badge color={st.key === 'redirect' ? 'violet' : st.key === 'ok' ? 'teal' : st.key === 'error' ? 'red' : 'orange'}>
              {st.label}
            </Badge>
            {d.target_url && (
              <Text size="sm" fw={600} c="violet" ff="monospace" className="break-all">→ {d.target_url}</Text>
            )}
            {d.final_status >= 400 && (
              <Badge color="orange" variant="light">nơi đến không mở được ({d.final_status})</Badge>
            )}
            {st.note && <Badge color="orange" variant="light">{st.note}</Badge>}
            <Box style={{ flex: 1 }} />
            <Button
              leftSection={busy ? <Loader size={11} /> : <ArrowClockwiseIcon size={13} />}
              onClick={check}
              disabled={busy}
              variant="default"
            >
              Kiểm tra ngay
            </Button>
            <Tooltip label="Ngừng theo dõi và xoá toàn bộ lịch sử của domain này">
              <Button
                color="red" variant="subtle"
                leftSection={<TrashIcon size={13} />}
                onClick={() => {
                  if (confirm(`Xoá ${hostOf(d.url)} khỏi danh sách theo dõi?`)) onDelete?.(d.id);
                }}
              >
                Xoá
              </Button>
            </Tooltip>
          </Group>

          {/* Truoc day sau thong tin nhet vao mot cau dai dinh lien nhau, mat phai
              doc het moi tim duoc thu can. Tach thanh cap nhan - gia tri de quet
              mat theo cot, va moi nhan noi ro y nghia thay vi ten truong. */}
          <Paper p="sm" mt="sm">
            <Stack gap={7}>
              <Fact label="Tình trạng này bắt đầu từ">
                {fmtVN(d.state_since)}{' '}
                <Text span c="dimmed" inherit>({ago(d.state_since)})</Text>
              </Fact>
              <Fact label="Kiểm tra gần nhất">
                {fmtVN(d.last_confirmed_at)}{' '}
                <Text span c="teal" inherit>— vẫn đúng như trên</Text>
              </Fact>
              <Fact label="Kiểm tra lại mỗi">
                {d.interval_sec} giây{' '}
                <Text span c="dimmed" inherit>
                  (nên biết được thời điểm đổi với sai số ±{d.interval_sec} giây)
                </Text>
              </Fact>
              <Fact label="Cách kiểm tra">
                {modeLabel(d.mode_used)}
                {MODE[d.mode_used] && (
                  <Text span c="dimmed" inherit> — {MODE[d.mode_used].giai}</Text>
                )}
              </Fact>
              <Fact label="Thời gian phản hồi">
                <Text span c={isSlow(d.latency_ms) ? 'orange' : undefined} inherit>
                  {fmtMs(d.latency_ms)}
                </Text>
                {isSlow(d.latency_ms) && (
                  <Text span c="dimmed" inherit> — chậm, thường do phải mở trình duyệt thật</Text>
                )}
              </Fact>
              <Fact label="Proxy đã dùng">{d.relay_node || '—'}</Fact>
            </Stack>
          </Paper>
          {/* Ly do bi chan noi bang mot cau, kem huong xu ly. Truoc day nguoi doc
              chi thay ma noi bo trong ngoac — "waf" — va khong biet lam gi tiep. */}
          {d.block_kind && d.block_kind !== 'none' && BLOCK_KIND[d.block_kind] && (
            <Paper p="sm" mt="sm" style={{ borderColor: 'var(--st-blocked)' }}>
              <Text size="sm" fw={600} c="orange">
                {BLOCK_KIND[d.block_kind].label}
              </Text>
              <Text size="sm" c="dimmed" mt={2}>
                {d.redirect_type
                  ? 'Vẫn đọc được lệnh chuyển hướng, nên nơi đến bên trên là chính xác. Chỉ là bản thân nơi đến không cho xem nội dung. '
                  : ''}
                {BLOCK_KIND[d.block_kind].huong}
              </Text>
            </Paper>
          )}

          {d.last_error && (
            <Text size="sm" c="red" mt={4}>
              Lần lỗi gần nhất: {d.last_error} — {fmtVN(d.last_error_at)}
            </Text>
          )}

          {/* Huong C: dai 72 gio la nhan vat chinh o day. */}
          <Section title="Hoạt động 72 giờ qua">
            <Paper p="sm">
              <Activity bars={bars || []} size="lg" />
              <Group justify="space-between" mt={6}>
                <Text size="xs" c="dimmed">72 giờ trước</Text>
                <Text size="xs" c="dimmed">bây giờ</Text>
              </Group>
              <Divider my="xs" />
              <ActivityLegend compact />
            </Paper>
          </Section>

          <Section title="Đường đi hiện tại">
            <Chain chain={d.chain} />
          </Section>

          {data.vantages?.length > 0 && (
            <Section title="Kết quả từ từng nơi kiểm tra">
              <Paper p="sm">
                <Stack gap={4}>
                  {data.vantages.map((v) => (
                    <Group key={v.vantage} gap="xs">
                      <Badge variant="default" size="xs">{v.vantage}</Badge>
                      <Text size="xs" w={34} ff="monospace">
                        {v.error_kind ? '—' : v.status_code ?? '—'}
                      </Text>
                      <Text size="xs" ff="monospace" c={v.error_kind ? 'red' : undefined}>
                        {v.error_kind
                          ? v.error_kind
                          : v.target_url
                          ? `→ ${hostOf(v.target_url)}`
                          : 'không chuyển hướng'}
                      </Text>
                    </Group>
                  ))}
                </Stack>
              </Paper>
            </Section>
          )}

          <Section title={`Lịch sử thay đổi (${data.changes.length} lần)`}>
            {data.changes.length ? (
              <Stack gap={5}>
                {data.changes.slice(0, 20).map((c) => (
                  <ChangeRow key={c.id} c={c} compact />
                ))}
              </Stack>
            ) : (
              <Text size="xs" c="dimmed">Từ khi bắt đầu theo dõi, domain này chưa đổi tình trạng lần nào.</Text>
            )}
          </Section>

          {data.errors?.length > 0 && (
            <Section title="Lần kiểm tra bị lỗi gần đây">
              <Paper p="sm">
                <ScrollArea.Autosize mah={170}>
                  <Stack gap={2}>
                    {data.errors.slice(0, 30).map((e, i) => (
                      <Text key={i} size="xs" c="dimmed" ff="monospace">
                        {fmtVN(e.at)} — <Text span c="red">{e.kind}</Text> {e.detail}
                      </Text>
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
              </Paper>
            </Section>
          )}
        </Box>
      )}
    </Modal>
  );
}
