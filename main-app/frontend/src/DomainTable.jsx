import * as React from 'react';
import {
  ActionIcon, Badge, Box, Button, Group, Loader, Paper, Select, Table, Text, TextInput, Tooltip,
} from '@mantine/core';
import {
  ArrowClockwiseIcon, ArrowDownIcon, ArrowRightIcon, ArrowUpIcon,
  MagnifyingGlassIcon, PencilSimpleIcon, PlusIcon,
} from '@phosphor-icons/react';
import { ago, domainState, hostOf, modeLabel, pathOf } from './lib';
import Activity, { ActivityLegend } from './Activity';

const FILTERS = [
  { value: 'all', label: 'Tất cả' },
  { value: 'redirect', label: 'Đang chuyển hướng' },
  { value: 'problem', label: 'Không kiểm tra được' },
  { value: 'ok', label: 'Bình thường' },
];

// Thu can doc phai noi len tren khi bang dai.
const RANK = { redirect: 0, error: 1, blocked: 2, ok: 3, idle: 4 };

export default function DomainTable({
  domains, bars, checking, filter, setFilter, onOpen, onCheck, onEdit, onAdd,
}) {
  const [q, setQ] = React.useState('');
  const [orderBy, setOrderBy] = React.useState('state');
  const [asc, setAsc] = React.useState(true);

  const rows = React.useMemo(() => {
    let list = domains.map((d) => ({ ...d, st: domainState(d) }));
    const term = q.toLowerCase().trim();
    if (term)
      list = list.filter((d) =>
        (d.url + ' ' + (d.label || '') + ' ' + (d.target_url || '')).toLowerCase().includes(term)
      );
    if (filter === 'redirect') list = list.filter((d) => d.st.key === 'redirect');
    if (filter === 'problem') list = list.filter((d) => ['error', 'blocked'].includes(d.st.key));
    if (filter === 'ok') list = list.filter((d) => d.st.key === 'ok');

    const cmp = {
      state: (a, b) => RANK[a.st.key] - RANK[b.st.key] || a.url.localeCompare(b.url),
      domain: (a, b) => hostOf(a.url).localeCompare(hostOf(b.url)),
      target: (a, b) => (a.target_url || '~').localeCompare(b.target_url || '~'),
      since: (a, b) => new Date(a.state_since || 0) - new Date(b.state_since || 0),
    }[orderBy];
    return [...list].sort((a, b) => (asc ? cmp(a, b) : -cmp(a, b)));
  }, [domains, q, filter, orderBy, asc]);

  /**
   * Gom theo nhan thuong hieu. Nhan von da co san trong du lieu nhung truoc day
   * chi lam chu mo duoi ten mien — trong khi day chinh la cach nguoi dung to
   * chuc cong viec: theo doi Go88 va Sunwin nhu hai tap hop rieng.
   * So sanh khong phan biet hoa thuong, nen "Sunwin" va "sunwin" ve mot nhom.
   */
  const groups = React.useMemo(() => {
    const m = new Map();
    for (const d of rows) {
      const raw = (d.label || '').trim();
      const key = raw.toLowerCase() || '￿';
      if (!m.has(key)) m.set(key, { name: raw || 'Chưa đặt nhãn', items: [] });
      m.get(key).items.push(d);
    }
    return [...m.values()].sort((a, b) => {
      if (a.name === 'Chưa đặt nhãn') return 1;
      if (b.name === 'Chưa đặt nhãn') return -1;
      return a.name.localeCompare(b.name);
    });
  }, [rows]);

  const Sort = ({ id, children }) => (
    <Table.Th style={{ whiteSpace: 'nowrap' }}>
      <Text
        component="button" size="xs" c="dimmed" fw={500}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit',
        }}
        onClick={() => (orderBy === id ? setAsc(!asc) : (setOrderBy(id), setAsc(true)))}
      >
        {children}
        {orderBy === id &&
          (asc ? <ArrowUpIcon size={9} style={{ marginLeft: 3 }} />
               : <ArrowDownIcon size={9} style={{ marginLeft: 3 }} />)}
      </Text>
    </Table.Th>
  );

  // "Chua co domain nao" KHAC voi "loc khong ra ket qua" — hai tinh huong,
  // hai cau, hai loi thoat khac nhau.
  if (!domains.length)
    return (
      <Paper p="xl">
        <Box ta="center" py="xl">
          <Text fw={600} size="lg">Chưa theo dõi domain nào</Text>
          <Text size="sm" c="dimmed" mt={6} maw={540} mx="auto">
            Thêm domain bạn muốn canh. Hệ thống sẽ kiểm tra định kỳ từ máy đặt tại Việt Nam
            và ghi lại khi nó bắt đầu chuyển hướng, đổi nơi đến, hoặc thôi không chuyển nữa.
          </Text>
          <Button mt="md" leftSection={<PlusIcon size={14} />} onClick={onAdd}>
            Thêm domain đầu tiên
          </Button>
        </Box>
      </Paper>
    );

  return (
    <Paper p={0}>
      <Group p="sm" gap="sm" wrap="wrap">
        <TextInput
          placeholder="Tìm theo domain, nhãn hoặc nơi đến…"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          leftSection={<MagnifyingGlassIcon size={14} />}
          style={{ flexGrow: 1, minWidth: 230, maxWidth: 360 }}
        />
        <Select
          data={FILTERS} value={filter}
          onChange={(v) => setFilter(v || 'all')}
          allowDeselect={false} w={210}
        />
        <Box style={{ flex: 1 }} />
        <Text size="sm" c="dimmed">
          {rows.length === domains.length
            ? `${domains.length} domain`
            : `${rows.length} / ${domains.length} domain`}
        </Text>
      </Group>

      {!rows.length ? (
        <Box ta="center" py="xl" px="md">
          <Text size="sm" fw={500}>Không có domain nào khớp</Text>
          <Text size="sm" c="dimmed" mt={4}>
            Thử xoá từ khoá tìm kiếm hoặc chọn lại bộ lọc "Tất cả".
          </Text>
          <Button variant="subtle" mt="sm" onClick={() => { setQ(''); setFilter('all'); }}>
            Bỏ bộ lọc
          </Button>
        </Box>
      ) : (
        <Table.ScrollContainer minWidth={940}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Sort id="state">Tình trạng</Sort>
                <Sort id="domain">Domain</Sort>
                <Sort id="target">Chuyển hướng sang</Sort>
                <Table.Th>
                  <Text size="xs" c="dimmed" fw={500}>Hoạt động 72 giờ qua</Text>
                </Table.Th>
                <Sort id="since">Giữ tình trạng này từ</Sort>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>

            {groups.map((g) => {
              const nRedirect = g.items.filter((d) => d.st.key === 'redirect').length;
              return (
                <Table.Tbody key={g.name}>
                  <Table.Tr style={{ background: 'var(--mantine-color-default-hover)' }}>
                    <Table.Td colSpan={6} py={5}>
                      <Group gap="xs">
                        <Text size="sm" fw={700}>{g.name}</Text>
                        <Badge variant="default">{g.items.length} domain</Badge>
                        {nRedirect > 0 && (
                          <Badge color="violet" variant="light">
                            {nRedirect} đang chuyển hướng
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>

                  {g.items.map((d) => (
                    <Table.Tr
                      key={d.id}
                      className={`row-click row-${d.st.key}`}
                      onClick={() => onOpen(d.id)}
                    >
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <Badge color={d.st.color} variant="light">{d.st.label}</Badge>
                          {d.st.code != null && (
                            <Badge variant="default" ff="monospace">{d.st.code}</Badge>
                          )}
                        </Group>
                      </Table.Td>

                      <Table.Td>
                        <Text size="sm" fw={600} ff="monospace">{hostOf(d.url)}</Text>
                      </Table.Td>

                      <Table.Td>
                        {d.target_url ? (
                          <Group gap={6} wrap="nowrap">
                            <ArrowRightIcon size={12} opacity={0.45} />
                            <Text size="sm" fw={600} c="violet" ff="monospace" title={d.target_url}>
                              {hostOf(d.target_url)}
                              <Text span c="dimmed" fw={400} inherit>{pathOf(d.target_url)}</Text>
                            </Text>
                            {d.st.note && (
                              <Badge color="orange" variant="light" size="sm">{d.st.note}</Badge>
                            )}
                          </Group>
                        ) : (
                          <Text size="sm" c="dimmed">— không chuyển hướng —</Text>
                        )}
                      </Table.Td>

                      <Table.Td w={200}>
                        <Activity bars={bars[d.id] || []} size="sm" />
                      </Table.Td>

                      <Table.Td>
                        <Text size="sm">{ago(d.state_since)}</Text>
                        <Text size="xs" c="dimmed">{modeLabel(d.mode_used)}</Text>
                      </Table.Td>

                      <Table.Td ta="right" onClick={(e) => e.stopPropagation()}>
                        <Group gap={2} justify="flex-end" wrap="nowrap">
                          <Tooltip label="Kiểm tra lại ngay">
                            <ActionIcon
                              onClick={() => onCheck(d.id)}
                              disabled={checking.has(d.id)}
                              aria-label="Kiểm tra lại ngay"
                            >
                              {checking.has(d.id)
                                ? <Loader size={13} />
                                : <ArrowClockwiseIcon size={14} />}
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Sửa hoặc xoá">
                            <ActionIcon onClick={() => onEdit(d)} aria-label="Sửa hoặc xoá domain">
                              <PencilSimpleIcon size={14} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              );
            })}
          </Table>
        </Table.ScrollContainer>
      )}

      <Box p="sm" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
        <ActivityLegend />
      </Box>
    </Paper>
  );
}
