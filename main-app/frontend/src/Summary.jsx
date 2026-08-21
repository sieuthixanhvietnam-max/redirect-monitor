import * as React from 'react';
import { Badge, Group, Paper, Text } from '@mantine/core';
import { fmtClock, REDIRECT_KINDS } from './lib';

/**
 * Mot bang chi tra loi MOT cau hoi, viet thanh cau tieng Viet.
 *
 * Ban truoc dung 5 the so ngang hang nhau, trong do co "do tre trung vi" —
 * mot con so khong dan toi hanh dong nao (day khong phai cong cu do toc do
 * website). Nam con so ngang nhau nghia la khong con so nao noi bat, nguoi doc
 * phai tu quyet dinh nhin cai nao truoc. Mot cau + vai chip phu thi khong.
 *
 * Danh sach "dich redirect hien tai" cung bi bo: bang ben duoi da tu day domain
 * chuyen huong len dau roi, ve lai lan nua la cung mot su that chiem hai cho.
 */
export default function Summary({ domains, changes, health, onFilter }) {
  if (!domains.length) return null;

  const redirecting = domains.filter((d) => d.redirect_type);
  const unchecked = domains.filter(
    (d) =>
      (d.consecutive_errors || 0) >= 2 ||
      (d.block_kind && d.block_kind !== 'none' && !d.redirect_type)
  );
  const deadTarget = redirecting.filter((d) => d.final_status >= 400);
  const dayAgo = Date.now() - 86400e3;
  const recent = changes.filter(
    (c) => REDIRECT_KINDS.has(c.change_kind) && new Date(c.created_at).getTime() > dayAgo
  );

  // Chip chi hien khi co gi de noi. Khong bao gio hien "0 ..." — mot con so 0
  // van bat mat dung lai doc roi moi nhan ra la khong co gi.
  const chips = [
    recent.length && {
      key: 'recent', color: 'violet',
      text: `${recent.length} thay đổi trong 24 giờ`,
    },
    deadTarget.length && {
      key: 'dead', color: 'orange', filter: 'redirect',
      text: `${deadTarget.length} nơi đến không mở được`,
    },
    unchecked.length && {
      key: 'unchecked', color: 'red', filter: 'problem',
      text: `${unchecked.length} không kiểm tra được`,
    },
  ].filter(Boolean);

  return (
    <Paper p="md">
      <Text size="xl" fw={600} lh={1.3}>
        <Text span c="violet" fw={700} inherit>
          {redirecting.length} trong {domains.length} domain
        </Text>{' '}
        đang chuyển hướng 301
      </Text>

      <Text size="sm" c="dimmed" mt={4}>
        Cập nhật {health ? fmtClock(health.now_vn) : '—'} giờ Việt Nam · kiểm tra{' '}
        {domains[0]?.interval_sec ?? 60} giây một lần, từ Proxy IP Việt Nam
      </Text>

      {chips.length > 0 && (
        <Group gap="xs" mt="sm">
          {chips.map((c) => (
            <Badge
              key={c.key}
              color={c.color}
              variant="light"
              style={{ cursor: c.filter ? 'pointer' : 'default' }}
              onClick={() => c.filter && onFilter?.(c.filter)}
            >
              {c.text}
            </Badge>
          ))}
        </Group>
      )}
    </Paper>
  );
}
