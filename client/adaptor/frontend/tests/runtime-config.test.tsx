import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeConfigDialog } from '../src/features/runtime/RuntimeConfigDialog';
import { mockApi, session } from './fixtures';

describe('runtime configuration', () => {
  it('preserves a saved key when left empty and submits the prompt and extension configuration', async () => {
    let saved: unknown;
    mockApi((_path, options) => {
      if (options.method === 'PATCH') {
        saved = JSON.parse(String(options.body));
        return session;
      }
    });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<RuntimeConfigDialog agentId="mia-id" onSaved={onSaved} onClose={() => {}} />);
    await screen.findByDisplayValue('model-a');
    expect(screen.getByLabelText(/^API Key/)).toHaveProperty('value', '');
    await user.selectOptions(screen.getByLabelText('系统提示词'), 'replace');
    await user.type(screen.getByLabelText('替换提示词正文'), '保持原有系统提示词行为');
    await user.click(screen.getByText('目录与扩展'));
    await user.clear(screen.getByLabelText('扩展绝对路径（可选，每行一个）'));
    await user.type(screen.getByLabelText('扩展绝对路径（可选，每行一个）'), ' /a.ts\n\n/b.ts ');
    await user.click(screen.getByRole('button', { name: '保存并检查' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(session));
    expect(saved).toEqual({
      harness: 'pi',
      config: {
        provider: 'custom',
        model: 'model-a',
        base_url: 'https://example.test/v1',
        api: 'openai-completions',
        system_prompt: { mode: 'replace', text: '保持原有系统提示词行为' },
        extensions: ['/a.ts', '/b.ts'],
      },
    });
  });

  it('clears a saved key only when explicitly selected', async () => {
    let saved: { config: Record<string, unknown> } | undefined;
    mockApi((_path, options) => {
      if (options.method === 'PATCH') {
        saved = JSON.parse(String(options.body));
        return session;
      }
    });
    const user = userEvent.setup();
    render(<RuntimeConfigDialog agentId="mia-id" onSaved={() => {}} onClose={() => {}} />);
    await screen.findByDisplayValue('model-a');
    await user.click(screen.getByRole('checkbox', { name: '保存时清除这个 Provider 的 API Key' }));
    expect(screen.getByLabelText(/^API Key/)).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: '保存并检查' }));
    await waitFor(() => expect(saved?.config.clear_api_key).toBe(true));
    expect(saved?.config).not.toHaveProperty('api_key');
  });

  it('shows a server error and retains the form for retry', async () => {
    const onSaved = vi.fn();
    mockApi((_path, options) => {
      if (options.method === 'PATCH')
        return new Response(JSON.stringify({ error: { message: '请先停用 Agent' } }), {
          status: 409,
        });
    });
    const user = userEvent.setup();
    render(<RuntimeConfigDialog agentId="mia-id" onSaved={onSaved} onClose={() => {}} />);
    await screen.findByDisplayValue('model-a');
    await user.click(screen.getByRole('button', { name: '保存并检查' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '请先停用 Agent');
    expect(screen.getByRole('button', { name: '保存并检查' })).toHaveProperty('disabled', false);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
