import * as React from 'react';
import {
  ActionIcon, Badge, Box, Button, Group, MantineProvider, Tabs, Text, Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import {
  DownloadSimpleIcon, MoonIcon, PlusIcon, SunIcon,
} from '@phosphor-icons/react';
import { theme } from './theme';
import { api, fmtClock, last72 } from './lib';
import Summary from './Summary';
import DomainTable from './DomainTable';
import Timeline from './Timeline';
import System from './System';
import DetailPanel from './DetailPanel';
import { AddDialog, EditDialog } from './Dialogs';

import '@mantine/core/styles.css';
import './app.css';

/**
 * Be rong toi da cua noi dung. Man hinh rong khong co nghia la nen trai het co:
 * dong chu dai qua 100 ky tu thi mat phai nhay dong, va bang dan ngang het man
 * hinh lam cot dau va cot cuoi xa nhau den muc kho doi chieu tren cung mot dong.
 * Thanh tieu de trai het chieu ngang, chi phan RUOT ben trong bi gioi han —
 * de vien duoi cua no van chay het man hinh nhu mot thanh cong cu that.
 */
const PAGE_MAX = 1320;

const POLL_FAST_MS = 7000;   // trang thai domain — doi bat cu luc nao
const POLL_SLOW_MS = 60000;  // chuoi theo gio — chi doi khi sang gio moi

function ThemeToggle() {
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const dark = colorScheme === 'dark';
  return (
    <Tooltip label={dark ? 'Chuyển nền sáng' : 'Chuyển nền tối'}>
      <ActionIcon onClick={toggleColorScheme} aria-label="Đổi nền sáng/tối">
        {dark ? <SunIcon size={15} /> : <MoonIcon size={15} />}
      </ActionIcon>
    </Tooltip>
  );
}

function Shell() {
  const [domains, setDomains] = React.useState([]);
  const [changes, setChanges] = React.useState([]);
  const [health, setHealth] = React.useState(null);
  const [series, setSeries] = React.useState({});
  const [tab, setTab] = React.useState('tong-quan');
  const [openId, setOpenId] = React.useState(null);
  const [editRow, setEditRow] = React.useState(null);
  const [adding, setAdding] = React.useState(false);
  const [checking, setChecking] = React.useState(new Set());
  const [filter, setFilter] = React.useState('all');

  const loadFast = React.useCallback(async () => {
    try {
      const [d, c, h] = await Promise.all([
        api('/api/domains'),
        api('/api/changes?limit=200'),
        api('/api/health'),
      ]);
      setDomains(d.domains || []);
      setChanges(c.changes || []);
      setHealth(h);
    } catch { /* giu du lieu cu, khong lam trang trong */ }
  }, []);

  const loadSlow = React.useCallback(async () => {
    try {
      const s = await api('/api/sparklines?hours=72');
      setSeries(s.series || {});
    } catch { /* dai hoat dong khong co thi bang van dung */ }
  }, []);

  React.useEffect(() => {
    loadFast();
    const t = setInterval(loadFast, POLL_FAST_MS);
    return () => clearInterval(t);
  }, [loadFast]);

  React.useEffect(() => {
    loadSlow();
    const t = setInterval(loadSlow, POLL_SLOW_MS);
    return () => clearInterval(t);
  }, [loadSlow]);

  // Tinh mot lan o day roi truyen xuong: bang va hop thoai dung chung ket qua.
  const bars = React.useMemo(() => {
    const m = {};
    for (const d of domains) m[d.id] = last72(series[d.id] || series[String(d.id)] || []);
    return m;
  }, [domains, series]);

  const checkNow = async (id) => {
    setChecking((s) => new Set(s).add(id));
    try {
      await api(`/api/domains/${id}/check`, { method: 'POST' });
      await loadFast();
    } finally {
      setChecking((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  const removeDomain = async (id) => {
    await api(`/api/domains/${id}`, { method: 'DELETE' });
    setOpenId(null);
    await loadFast();
  };

  return (
    <Box>
      <Box
        style={{
          borderBottom: '1px solid var(--mantine-color-default-border)',
          position: 'sticky', top: 0, zIndex: 20,
          background: 'var(--mantine-color-body)',
        }}
      >
      <Group
        px="md" py={9} gap="sm" wrap="nowrap"
        style={{ maxWidth: PAGE_MAX, margin: '0 auto' }}
      >
        {/* Khong dat ff="monospace" o day: ten co dau tieng Viet, ma chu don cach
            nen dau chong lai — do la ly do ca giao dien tach hai ho chu. */}
        <Text fw={600} size="md">Theo Dõi Trạng Thái 301</Text>
        <Box style={{ flex: 1 }} />
        <Tooltip label="Tải toàn bộ lịch sử thay đổi về máy (.csv, mở được bằng Excel)">
          <ActionIcon component="a" href="/api/export/changes.csv" aria-label="Tải lịch sử về máy">
            <DownloadSimpleIcon size={15} />
          </ActionIcon>
        </Tooltip>
        <ThemeToggle />
        <Button leftSection={<PlusIcon size={13} />} onClick={() => setAdding(true)}>
          Thêm domain
        </Button>
      </Group>
      </Box>

      <Tabs
        value={tab} onChange={setTab} px="md" pt="sm"
        style={{ maxWidth: PAGE_MAX, margin: '0 auto' }}
      >
        <Tabs.List>
          <Tabs.Tab value="tong-quan">Tổng quan</Tabs.Tab>
          <Tabs.Tab value="thay-doi">Lịch sử thay đổi</Tabs.Tab>
          <Tabs.Tab value="he-thong">Nguồn kiểm tra</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="tong-quan" pt="md">
          <Summary
            domains={domains}
            changes={changes}
            health={health}
            onFilter={setFilter}
          />
          <Box mt="md">
            <DomainTable
              domains={domains}
              bars={bars}
              checking={checking}
              filter={filter}
              setFilter={setFilter}
              onOpen={setOpenId}
              onCheck={checkNow}
              onEdit={setEditRow}
              onAdd={() => setAdding(true)}
            />
          </Box>
        </Tabs.Panel>

        <Tabs.Panel value="thay-doi" pt="md">
          <Timeline changes={changes} />
        </Tabs.Panel>

        <Tabs.Panel value="he-thong" pt="md">
          <System health={health} />
        </Tabs.Panel>
      </Tabs>

      <DetailPanel
        id={openId}
        bars={openId ? bars[openId] : null}
        onClose={() => setOpenId(null)}
        onChanged={loadFast}
        onDelete={removeDomain}
      />
      <AddDialog
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={loadFast}
      />
      <EditDialog
        row={editRow}
        onClose={() => setEditRow(null)}
        onSaved={loadFast}
        onDeleted={(id) => { if (openId === id) setOpenId(null); }}
      />
    </Box>
  );
}

export default function App() {
  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Shell />
    </MantineProvider>
  );
}
