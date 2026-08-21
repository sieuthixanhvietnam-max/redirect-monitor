import * as React from 'react';
import {
  Alert, Badge, Box, Button, Group, Loader, Paper, Table, Text,
} from '@mantine/core';
import { ArrowClockwiseIcon, WarningIcon } from '@phosphor-icons/react';
import { api, fmtVN } from './lib';

function Country({ c }) {
  if (!c) return <Badge variant="default" size="xs">—</Badge>;
  return (
    <Badge color={c === 'VN' ? 'teal' : 'orange'} variant="light" size="xs">{c}</Badge>
  );
}

function Panel({ title, right, children }) {
  return (
    <Paper p={0}>
      <Group p="sm" gap="xs">
        <Text size="xs" fw={700} tt="uppercase" style={{ letterSpacing: '.07em' }}>
          {title}
        </Text>
        <Box style={{ flex: 1 }} />
        {right}
      </Group>
      {children}
    </Paper>
  );
}

export default function System({ health }) {
  const [relays, setRelays] = React.useState([]);
  const [vantages, setVantages] = React.useState([]);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [r, v] = await Promise.all([
        api('/api/relays'),
        api('/api/vantages').catch(() => ({ vantages: [] })),
      ]);
      setRelays(r.health || []);
      setVantages(v.vantages || []);
    } catch { /* giu du lieu cu */ }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const recheck = async () => {
    setBusy(true);
    try {
      await api('/api/relays/check', { method: 'POST' });
      await load();
    } finally { setBusy(false); }
  };

  const nonVN = vantages.filter((v) => v.country && v.country !== 'VN');
  const deadRelay = relays.filter((r) => !r.ok);

  return (
    <Box>
      {/* Cau tra loi cho "tab nay de lam gi" phai nam ngay dong dau tien,
          khong bat nguoi doc suy ra tu ba cai bang ben duoi. */}
      <Paper p="md" mb="md">
        <Text size="md" fw={600}>Kết quả trên trang này đến từ đâu</Text>
        <Text size="sm" c="dimmed" mt={4}>
          Nhiều website chặn hoặc trả nội dung khác nhau tuỳ vào IP của người truy cập.
          Vì vậy hệ thống không kiểm tra trực tiếp từ máy chủ, mà đi qua một proxy có
          IP Việt Nam — để thấy đúng những gì người dùng Việt Nam thấy.
          Trang này cho biết proxy đó còn sống không và đang đi ra từ đâu.
        </Text>
      </Paper>

      {deadRelay.length > 0 && (
        <Alert
          color="red" mb="md" icon={<WarningIcon weight="fill" />}
          title={`Proxy không phản hồi: ${deadRelay.map((r) => r.node).join(', ')}`}
        >
          Trong lúc máy này hỏng, hệ thống bỏ qua lượt kiểm tra thay vì kiểm tra bằng IP
          nước ngoài. Tình trạng domain đang hiển thị là lần xác nhận cuối cùng, không
          phải tình hình ngay lúc này.
        </Alert>
      )}

      {nonVN.length > 0 && (
        <Alert
          color="orange" mb="md" icon={<WarningIcon weight="fill" />}
          title={`Có nơi kiểm tra đang đi ra từ ${nonVN.map((v) => v.country).join(', ')}`}
        >
          Nhiều website trả nội dung khác nhau tuỳ quốc gia của người truy cập, nên kết quả từ nơi đó không phản ánh điều người dùng Việt Nam nhìn thấy.
        </Alert>
      )}

      <Panel
        title="Đối chiếu nhiều nơi"
        right={
          <Button
            variant="default"
            onClick={recheck}
            disabled={busy}
            leftSection={busy ? <Loader size={11} /> : <ArrowClockwiseIcon size={12} />}
          >
            Kiểm tra lại ngay
          </Button>
        }
      >
        {vantages.length ? (
          <Table.ScrollContainer minWidth={620}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Nơi</Table.Th><Table.Th>Vai trò</Table.Th>
                  <Table.Th>IP đi ra</Table.Th><Table.Th>Quốc gia</Table.Th>
                  <Table.Th>Nhà mạng</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {vantages.map((v) => (
                  <Table.Tr key={v.name}>
                    <Table.Td><Text size="sm" ff="monospace">{v.name}</Text></Table.Td>
                    <Table.Td>
                      {v.primary
                        ? <Badge color="violet" variant="light" size="xs">chính</Badge>
                        : <Text size="xs" c="dimmed">đối chiếu</Text>}
                    </Table.Td>
                    <Table.Td><Text size="sm" ff="monospace">{v.ip || '—'}</Text></Table.Td>
                    <Table.Td><Country c={v.country} /></Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{v.isp || v.error || ''}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : (
          <Text size="sm" c="dimmed" px="sm" pb="sm">
            Hiện chỉ dùng một proxy, nên không có gì để đối chiếu.
            Nếu thêm proxy thứ hai đặt ở nơi khác, hệ thống sẽ kiểm tra cùng một domain
            từ cả hai và so kết quả. Hai nơi ra hai kết quả khác nhau nghĩa là website
            đang cố tình cho mỗi người xem một thứ khác nhau — thường để giấu trang thật
            khỏi công cụ kiểm tra.
            <br /><br />
            <Text span size="sm" c="dimmed" inherit>
              Bật bằng biến RELAY_PROXIES (trong vn-relay/.env) và VANTAGES (trong main-app/.env).
            </Text>
          </Text>
        )}
      </Panel>

      <Box mt="md">
        <Panel title="Proxy đang dùng">
          <Table.ScrollContainer minWidth={760}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Tên</Table.Th><Table.Th>Địa chỉ nội bộ</Table.Th>
                  <Table.Th>Tình trạng</Table.Th><Table.Th>IP đi ra</Table.Th>
                  <Table.Th>Quốc gia</Table.Th><Table.Th>Lỗi gần nhất</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {relays.map((h) => (
                  <Table.Tr key={h.node}>
                    <Table.Td><Text size="sm" ff="monospace">{h.node}</Text></Table.Td>
                    <Table.Td><Text size="xs" c="dimmed" ff="monospace">{h.url}</Text></Table.Td>
                    <Table.Td>
                      <Badge color={h.ok ? 'teal' : 'red'} variant="light" size="xs">
                        {h.ok ? 'OK' : 'LỖI'}
                      </Badge>
                    </Table.Td>
                    <Table.Td><Text size="sm" ff="monospace">{h.egress_ip || '—'}</Text></Table.Td>
                    <Table.Td><Country c={h.country} /></Table.Td>
                    <Table.Td><Text size="xs" c="red">{h.last_error || ''}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Panel>
      </Box>

      {health && (
        <Paper p="sm" mt="md">
          <Text size="xs" fw={700} tt="uppercase" mb={5} style={{ letterSpacing: '.07em' }}>
            Tình hình chung
          </Text>
          <Text size="sm" c="dimmed">
            Chạy liên tục từ {fmtVN(health.stats?.started_at)} ·{' '}
            đã kiểm tra {health.stats?.checks?.toLocaleString('vi-VN')} lượt ·{' '}
            {health.stats?.errors?.toLocaleString('vi-VN')} lượt lỗi ·{' '}
            ghi nhận {health.stats?.changes} thay đổi
            <br />
            Khi máy tại Việt Nam hỏng:{' '}
            <b>{health.direct_fallback ? 'vẫn kiểm tra bằng IP máy chủ' : 'bỏ qua lượt kiểm tra'}</b>
            {!health.direct_fallback
              ? ' — thà không có số liệu còn hơn có số liệu sai'
              : ' — cẩn thận: kết quả lúc đó không phản ánh điều người dùng Việt Nam thấy'}
            <br />
            Không có kênh báo tự động: thay đổi chỉ thấy được khi bạn mở trang này.
          </Text>
        </Paper>
      )}
    </Box>
  );
}
