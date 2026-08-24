'use client';
// 도구 사용 카드 — Claude Code CLI와 유사한 진행상황 표시

import { useState } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ChevronRight, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import type { ActiveToolUse } from '@/types/message';
import { getToolDisplay, formatResultSummary } from './toolUseHelpers';

interface ToolUseCardProps {
  toolUse: ActiveToolUse;
}

export function ToolUseCard({ toolUse }: ToolUseCardProps) {
  const [open, setOpen] = useState(false);
  const isRunning = toolUse.status === 'running';
  const display = getToolDisplay(toolUse);
  const hasContent = !!(toolUse.output || toolUse.input);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className="my-1.5 rounded-lg overflow-hidden border text-sm"
        style={{ backgroundColor: '#FAFAF8', borderColor: '#E8E5DE' }}
      >
        {/* 헤더 */}
        <CollapsibleTrigger className="flex items-center gap-2 w-full px-3 py-2 cursor-pointer hover:bg-[#F5F5EF] transition-colors">
          {hasContent && (
            <ChevronRight
              size={12}
              className="shrink-0 transition-transform"
              style={{ color: '#9CA3AF', transform: open ? 'rotate(90deg)' : undefined }}
            />
          )}
          <display.Icon
            size={14}
            className="shrink-0"
            style={{ color: toolUse.isError ? '#E0845E' : '#2D7D7B' }}
          />
          <span className="shrink-0 text-xs font-medium" style={{ color: '#3D3D3D' }}>
            {display.label}
          </span>
          {display.inline && (
            <span
              className={`truncate text-xs ${display.isCode ? 'font-mono px-1 py-0.5 rounded' : ''}`}
              style={{
                color: '#6B6B7B',
                ...(display.isCode ? { backgroundColor: '#F0F0EC' } : {}),
              }}
              title={display.inlineFull}
            >
              {display.inline}
            </span>
          )}
          <span className="flex-1" />
          {isRunning ? (
            <Loader2 size={12} className="shrink-0 animate-spin" style={{ color: '#2D7D7B' }} />
          ) : toolUse.isError ? (
            <XCircle size={12} className="shrink-0" style={{ color: '#E0845E' }} />
          ) : (
            <span className="flex items-center gap-1 shrink-0">
              <CheckCircle2 size={12} style={{ color: '#2D7D7B' }} />
              <span className="text-[11px]" style={{ color: '#9CA3AF' }}>
                {formatResultSummary(toolUse)}
              </span>
            </span>
          )}
        </CollapsibleTrigger>

        {/* 접기 내용 — 실제 도구 결과 표시 */}
        <CollapsibleContent>
          <div className="border-t" style={{ borderColor: '#E8E5DE' }}>
            {/* 도구 입력 — Edit의 경우 old/new string, Bash의 경우 command */}
            {toolUse.input && (
              <ToolInput tool={toolUse.tool} input={toolUse.input} />
            )}
            {/* 도구 출력 — 파일 내용, bash 출력 등 */}
            {toolUse.output && (
              <ToolOutput output={toolUse.output} isError={toolUse.isError} />
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/** 도구 입력 표시 — 도구별로 다르게 포맷 */
function ToolInput({ tool, input }: { tool: string; input: Record<string, unknown> }) {
  const t = tool.toLowerCase();

  // Edit: old_string → new_string diff 스타일
  const oldStr = input.old_string != null ? String(input.old_string) : null;
  const newStr = input.new_string != null ? String(input.new_string) : null;
  if (t === 'edit' && (oldStr || newStr)) {
    return (
      <div className="px-3 py-2 space-y-1">
        {oldStr && (
          <pre className="text-xs font-mono p-2 rounded overflow-x-auto max-h-40 leading-relaxed"
            style={{ backgroundColor: '#FEF2F2', color: '#991B1B' }}>
            {oldStr.split('\n').map((l) => `- ${l}`).join('\n')}
          </pre>
        )}
        {newStr && (
          <pre className="text-xs font-mono p-2 rounded overflow-x-auto max-h-40 leading-relaxed"
            style={{ backgroundColor: '#F0FDF4', color: '#166534' }}>
            {newStr.split('\n').map((l) => `+ ${l}`).join('\n')}
          </pre>
        )}
      </div>
    );
  }

  // Write: content 표시
  if (t === 'write' && input.content != null) {
    return (
      <div className="px-3 py-2">
        <pre className="text-xs font-mono p-2 rounded overflow-x-auto max-h-60 leading-relaxed"
          style={{ backgroundColor: '#F0FDF4', color: '#166534' }}>
          {String(input.content)}
        </pre>
      </div>
    );
  }

  // 기타: JSON 표시 (간결하게)
  return null;
}

/** 도구 출력 표시 — 파일 내용, bash 출력 등 */
function ToolOutput({ output, isError }: { output: string; isError?: boolean }) {
  if (!output) return null;

  // 출력이 짧은 경우 (경로만 표시된 경우 등) 표시 안 함
  if (output.length < 5 && !isError) return null;

  return (
    <div className="px-3 py-2">
      <pre
        className="text-xs font-mono p-2 rounded overflow-x-auto max-h-60 leading-relaxed whitespace-pre-wrap"
        style={{
          backgroundColor: isError ? '#FEF2F2' : '#1A1A2E',
          color: isError ? '#991B1B' : '#E2E8F0',
        }}
      >
        {output}
      </pre>
    </div>
  );
}
