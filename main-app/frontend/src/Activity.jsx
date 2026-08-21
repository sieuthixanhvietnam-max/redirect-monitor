import * as React from 'react';
import { Group, Text } from '@mantine/core';
import { barH, barTitle, peakOf } from './lib';

/**
 * Dai hoat dong 72 gio. Mot component, hai co:
 *   size="sm" — nam gon trong dong bang (huong A)
 *   size="lg" — nhan vat chinh trong hop thoai chi tiet (huong C)
 */
export default function Activity({ bars, size = 'sm' }) {
  const peak = React.useMemo(() => peakOf(bars || []), [bars]);
  if (!bars?.length) return null;
  return (
    <div className={`strip ${size}`}>
      {bars.map((b, i) =>
        b ? (
          <i
            key={i}
            className={`bar-${b.kind}${b.partial ? ' bar-partial' : ''}`}
            style={{ height: `${barH(b, peak)}%` }}
            title={barTitle(b)}
          />
        ) : (
          <i key={i} className="bar-null" title={barTitle(null)} />
        )
      )}
    </div>
  );
}

export function ActivityLegend({ compact }) {
  const items = [
    ['ok', 'bình thường'],
    ['redirect', 'có chuyển hướng'],
    ['blocked', 'bị chặn'],
    ['error', 'không kiểm tra được'],
    ['null', 'chưa theo dõi'],
  ];
  return (
    <Group gap="md" wrap="wrap">
      {items.map(([k, label]) => (
        <Group key={k} gap={5} wrap="nowrap">
          <span
            className={`bar-${k}`}
            style={{ width: 9, height: 9, borderRadius: 2, display: 'inline-block' }}
          />
          <Text size="xs" c="dimmed">{label}</Text>
        </Group>
      ))}
      {!compact && (
        <Text size="xs" c="dimmed">
          Mỗi cột là một giờ, xếp từ 72 giờ trước đến bây giờ. Màu thể hiện tình trạng
          chiếm đa số trong giờ đó; cột cao thấp theo số lần kiểm tra.
        </Text>
      )}
    </Group>
  );
}
