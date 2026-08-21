import * as React from 'react';
import {
  Alert, Box, Button, Group, Modal, NumberInput, Select, Stack, Text, Textarea, TextInput,
} from '@mantine/core';
import { TrashIcon } from '@phosphor-icons/react';
import { api } from './lib';

// Ten cach kiem tra doi tu ten ky thuat sang ten noi duoc CONG DUNG,
// kem mot cau danh doi de nguoi chon biet minh danh doi cai gi lay cai gi.
const MODES = [
  { value: 'auto', label: 'Tự động — thử cách nhanh trước, bị chặn thì tự mở trình duyệt thật' },
  { value: 'http', label: 'Nhanh — nhẹ nhất, nhưng bỏ sót chuyển hướng bằng JavaScript' },
  { value: 'browser', label: 'Trình duyệt thật — chậm hơn nhiều, nhưng thấy được nhiều nhất' },
  { value: 'head', label: 'Siêu nhẹ — chỉ hỏi phần đầu trang, bỏ sót nhiều loại chuyển hướng' },
];

const INTERVAL_NOTE =
  'Khoảng cách giữa hai lần kiểm tra quyết định độ chính xác của thời điểm: kiểm tra ' +
  'mỗi 60 giây thì chỉ biết được domain đổi vào lúc nào với sai số ±60 giây. Kiểm tra ' +
  'dày hơn cho sai số nhỏ hơn, nhưng dễ bị website chặn IP hơn.';

export function AddDialog({ open, onClose, onSaved }) {
  const [how, setHow] = React.useState('one');
  const [url, setUrl] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [bulk, setBulk] = React.useState('');
  const [interval, setInterval] = React.useState(60);
  const [mode, setMode] = React.useState('auto');
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      if (how === 'one') {
        await api('/api/domains', {
          method: 'POST',
          body: JSON.stringify({ url, label, interval_sec: +interval, mode }),
        });
      } else {
        await api('/api/domains/bulk', {
          method: 'POST',
          body: JSON.stringify({ text: bulk, interval_sec: +interval, mode }),
        });
      }
      setUrl(''); setLabel(''); setBulk('');
      onSaved?.();
      onClose();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={open} onClose={onClose} title="Thêm domain" size="lg">
      <Stack gap="sm">
        <Select
          label="Cách thêm"
          value={how}
          onChange={(v) => setHow(v || 'one')}
          allowDeselect={false}
          data={[
            { value: 'one', label: 'Một domain' },
            { value: 'bulk', label: 'Hàng loạt' },
          ]}
        />

        {how === 'one' ? (
          <>
            <TextInput
              label="URL" placeholder="https://vidu.com/"
              value={url} onChange={(e) => setUrl(e.currentTarget.value)}
            />
            <TextInput
              label="Nhãn (tuỳ chọn)" placeholder="Tên thương hiệu — dùng để gom nhóm trong bảng"
              value={label} onChange={(e) => setLabel(e.currentTarget.value)}
            />
          </>
        ) : (
          <Textarea
            label="Mỗi dòng một domain, dạng: url, nhãn"
            rows={7}
            placeholder={'https://a.com, Nhãn A\nhttps://b.com, Nhãn B'}
            value={bulk}
            onChange={(e) => setBulk(e.currentTarget.value)}
          />
        )}

        <Group gap="sm" align="flex-end" grow>
          <NumberInput
            label="Kiểm tra mỗi (giây)" min={10} max={86400}
            value={interval} onChange={setInterval}
          />
          <Select
            label="Cách kiểm tra" value={mode}
            onChange={(v) => setMode(v || 'auto')}
            allowDeselect={false} data={MODES}
          />
        </Group>

        <Text size="xs" c="dimmed">{INTERVAL_NOTE}</Text>

        {err && <Alert color="red">{err}</Alert>}

        <Group justify="flex-end" gap="xs" mt="xs">
          <Button variant="subtle" color="gray" onClick={onClose}>Huỷ</Button>
          <Button
            onClick={submit}
            loading={busy}
            disabled={how === 'one' ? !url : !bulk}
          >
            Thêm
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function EditDialog({ row, onClose, onSaved, onDeleted }) {
  const [label, setLabel] = React.useState('');
  const [interval, setInterval] = React.useState(60);
  const [mode, setMode] = React.useState('auto');
  const [enabled, setEnabled] = React.useState('1');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (row) {
      setLabel(row.label || '');
      setInterval(row.interval_sec);
      setMode(row.mode);
      setEnabled(String(row.enabled));
    }
  }, [row]);

  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/domains/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ label, interval_sec: +interval, mode, enabled: +enabled }),
      });
      onSaved?.();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  // Xoa keo theo toan bo lich su thay doi cua domain — mat hep dinh nghia
  // "thoi diem 301 lan dau", tuc thu quy nhat ma he thong tich duoc.
  // Vi vay hoi xac nhan bang chinh ten mien chu khong phai mot cu bam.
  const del = async () => {
    const host = (() => { try { return new URL(row.url).host; } catch { return row.url; } })();
    const answer = prompt(
      `Xoá ${host} khỏi danh sách theo dõi?\n\n` +
      `Toàn bộ lịch sử thay đổi của domain này sẽ mất và không khôi phục được.\n` +
      `Nếu chỉ muốn ngừng kiểm tra tạm thời, hãy đổi Tình trạng theo dõi sang "Tạm dừng".\n\n` +
      `Gõ lại tên miền để xác nhận:`
    );
    if (answer === null) return;
    if (answer.trim() !== host) {
      alert(`Không khớp — đã huỷ. Bạn gõ "${answer.trim()}", cần "${host}".`);
      return;
    }
    setBusy(true);
    try {
      await api(`/api/domains/${row.id}`, { method: 'DELETE' });
      onDeleted?.(row.id);
      onSaved?.();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      opened={!!row}
      onClose={onClose}
      size="lg"
      title={<Text fw={600} className="break-all">{row?.url}</Text>}
    >
      <Stack gap="sm">
        <TextInput
          label="Nhãn" value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
        />
        <Group gap="sm" align="flex-end" grow>
          <NumberInput
            label="Kiểm tra mỗi (giây)" min={10} max={86400}
            value={interval} onChange={setInterval}
          />
          <Select
            label="Chế độ" value={mode}
            onChange={(v) => setMode(v || 'auto')}
            allowDeselect={false} data={MODES}
          />
        </Group>
        <Select
          label="Tình trạng theo dõi" value={enabled}
          onChange={(v) => setEnabled(v || '1')}
          allowDeselect={false}
          data={[
            { value: '1', label: 'Đang theo dõi' },
            { value: '0', label: 'Tạm dừng — giữ lịch sử, ngừng kiểm tra' },
          ]}
        />
        <Text size="xs" c="dimmed">{INTERVAL_NOTE}</Text>

        <Group gap="xs" mt="xs">
          <Button
            color="red" variant="light" onClick={del} disabled={busy}
            leftSection={<TrashIcon size={15} />}
          >
            Xoá domain
          </Button>
          <Box style={{ flex: 1 }} />
          <Button variant="subtle" color="gray" onClick={onClose}>Huỷ</Button>
          <Button onClick={save} loading={busy}>Lưu</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
