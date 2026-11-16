import { useEffect, useState, type FormEvent } from 'react';
import { getRuntime, updateRuntime } from '../../api/runtime';
import type {
  MainSession,
  ProviderOption,
  RuntimeDetails,
  SystemPromptConfiguration,
  UpdateRuntimeInput,
} from '../../api/types';
import { Modal } from '../../components/Modal';

const protocols = [
  ['openai-completions', 'OpenAI Chat Completions'],
  ['openai-responses', 'OpenAI Responses'],
  ['anthropic-messages', 'Anthropic Messages'],
  ['google-generative-ai', 'Google Generative AI'],
];
function defaults(option: ProviderOption | undefined, model: string) {
  const selected = option?.models.find((value) => value.id === model);
  const urls = new Set(option?.models.map((value) => value.base_url));
  const apis = new Set(option?.models.map((value) => value.api));
  return {
    baseUrl: selected?.base_url || option?.base_url || (urls.size === 1 ? [...urls][0] : '') || '',
    apiType: selected?.api || option?.api || (apis.size === 1 ? [...apis][0] : '') || '',
  };
}

export function RuntimeConfigDialog({
  agentId,
  onSaved,
  onClose,
}: {
  agentId: string;
  onSaved: (state: MainSession) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<RuntimeDetails>();
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiType, setApiType] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [extensions, setExtensions] = useState('');
  const [promptMode, setPromptMode] = useState<SystemPromptConfiguration['mode']>('default');
  const [promptText, setPromptText] = useState('');
  const [urlEdited, setUrlEdited] = useState(false);
  const [apiEdited, setApiEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void getRuntime(agentId, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setData(value);
        const config = value.runtime.config;
        setProvider(config.provider ?? '');
        setModel(config.model ?? '');
        setExtensions(config.extensions?.join('\n') ?? '');
        setPromptMode(config.system_prompt.mode);
        setPromptText(config.system_prompt.text);
        const preset = defaults(
          value.model_options.find((option) => option.id === config.provider),
          config.model ?? '',
        );
        setBaseUrl(preset.baseUrl);
        setApiType(preset.apiType);
        if (value.configuration_issue) setError(value.configuration_issue);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('配置读取失败，请检查本机服务');
      });
    return () => controller.abort();
  }, [agentId]);

  const selectedProvider = data?.model_options.find((option) => option.id === provider.trim());
  const selectedModel = selectedProvider?.models.find((option) => option.id === model.trim());
  const hasFields = !!(provider || model || baseUrl || apiType || apiKey || clearKey);
  function changeProvider(value: string) {
    setProvider(value);
    setModel('');
    setApiKey('');
    setClearKey(false);
    setUrlEdited(false);
    setApiEdited(false);
    const preset = defaults(
      data?.model_options.find((option) => option.id === value.trim()),
      '',
    );
    setBaseUrl(preset.baseUrl);
    setApiType(preset.apiType);
  }
  function changeModel(value: string) {
    setModel(value);
    const preset = defaults(selectedProvider, value.trim());
    if (!urlEdited) setBaseUrl(preset.baseUrl);
    if (
      !apiEdited ||
      selectedProvider?.models.find((option) => option.id === value.trim())?.builtin
    )
      setApiType(preset.apiType);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (
        promptMode === 'replace' &&
        (!promptText.trim() || new TextEncoder().encode(promptText).length > 65536)
      ) {
        throw new Error('替换模式需要填写系统提示词，UTF-8 长度不能超过 64 KiB');
      }
      const config: UpdateRuntimeInput['config'] = {
        provider,
        model,
        ...(provider || model
          ? {
              base_url: baseUrl,
              api: apiType,
              ...(apiKey.trim() ? { api_key: apiKey } : {}),
              ...(clearKey ? { clear_api_key: true } : {}),
            }
          : {}),
        system_prompt: { mode: promptMode, text: promptMode === 'replace' ? promptText : '' },
        extensions: extensions
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean),
      };
      const state = await updateRuntime(agentId, { harness: 'pi', config });
      setApiKey('');
      onSaved(state);
    } catch (error) {
      setError(error instanceof Error ? error.message : '配置保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal titleId="runtime-title" title="Pi 运行配置" className="runtime-dialog">
      <p>模型、认证和系统提示词保存在此 Agent 自己的 pi-config 中。</p>
      <form onSubmit={save} autoComplete="off">
        <fieldset disabled={busy || !data} className="runtime-fields">
          <div className="model-fields">
            <div>
              <label htmlFor="runtime-provider">Provider</label>
              <input
                id="runtime-provider"
                list="runtime-providers"
                required={hasFields}
                autoFocus
                value={provider}
                onChange={(event) => changeProvider(event.target.value)}
                placeholder="选择或输入服务标识"
              />
              <datalist id="runtime-providers">
                {data?.model_options.map((option) => (
                  <option key={option.id} value={option.id} />
                ))}
              </datalist>
            </div>
            <div>
              <label htmlFor="runtime-model">Model</label>
              <input
                id="runtime-model"
                list="runtime-models"
                required={hasFields}
                value={model}
                onChange={(event) => changeModel(event.target.value)}
                placeholder="准确的模型 ID"
              />
              <datalist id="runtime-models">
                {selectedProvider?.models.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </datalist>
            </div>
          </div>
          <label htmlFor="runtime-base-url">接口地址（Base URL）</label>
          <input
            id="runtime-base-url"
            type="url"
            required={!!provider && !!model && !selectedModel?.builtin}
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setUrlEdited(true);
            }}
            placeholder="例如 https://api.example.com/v1"
          />
          <small className="field-hint">
            填写基础地址，不包含 /chat/completions 或 /responses。内置模型留空使用默认地址。
          </small>
          <label htmlFor="runtime-api-key">
            API Key{' '}
            <span className="credential-status">
              {selectedProvider?.has_api_key ? '已配置' : '未配置'}
            </span>
          </label>
          <input
            id="runtime-api-key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            disabled={clearKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              selectedProvider?.has_api_key
                ? '留空保留已有 Key；填写则替换'
                : '输入此 Agent 使用的 API Key'
            }
          />
          {selectedProvider?.has_oauth && (
            <small className="field-hint">
              已保存 OAuth 认证；填写 API Key 将替换该 Provider 的 OAuth。
            </small>
          )}
          {selectedProvider?.has_api_key && (
            <label className="clear-key">
              <input
                type="checkbox"
                checked={clearKey}
                disabled={!!apiKey.trim()}
                onChange={(event) => setClearKey(event.target.checked)}
              />
              保存时清除这个 Provider 的 API Key
            </label>
          )}
          <label htmlFor="runtime-api">
            接口类型{selectedModel?.builtin ? '（内置模型自动确定）' : ''}
          </label>
          <select
            id="runtime-api"
            value={apiType}
            disabled={!!selectedModel?.builtin}
            required={!!provider && !!model && !selectedModel?.builtin}
            onChange={(event) => {
              setApiType(event.target.value);
              setApiEdited(true);
            }}
          >
            <option value="">请选择接口协议</option>
            {protocols.map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
            {apiType && !protocols.some(([value]) => value === apiType) && (
              <option value={apiType}>{apiType}</option>
            )}
          </select>
          <label htmlFor="runtime-prompt-mode">系统提示词</label>
          <select
            id="runtime-prompt-mode"
            value={promptMode}
            onChange={(event) =>
              setPromptMode(event.target.value as SystemPromptConfiguration['mode'])
            }
          >
            <option value="default">Pi 默认</option>
            <option value="replace">替换</option>
          </select>
          {promptMode === 'replace' ? (
            <>
              <label htmlFor="runtime-prompt-text">替换提示词正文</label>
              <textarea
                id="runtime-prompt-text"
                className="system-prompt-text"
                rows={7}
                required
                value={promptText}
                onChange={(event) => setPromptText(event.target.value)}
                placeholder="填写这个 Agent 的身份、职责和行为要求"
              />
              <small className="field-hint">
                替换 Pi 默认提示词主体；项目指令、Skills 和工作目录仍会追加。工具能力不变。最多 64
                KiB。
              </small>
            </>
          ) : (
            <small className="field-hint">
              使用 Pi 内置系统提示词。保存后移除这个 Agent 的 SYSTEM.md。
            </small>
          )}
          <details className="runtime-advanced">
            <summary>目录与扩展</summary>
            <label htmlFor="runtime-cwd">工作目录</label>
            <textarea id="runtime-cwd" rows={2} readOnly value={data?.directories.cwd ?? ''} />
            <label htmlFor="runtime-directory">Pi 私有配置目录</label>
            <textarea
              id="runtime-directory"
              rows={2}
              readOnly
              value={data?.directories.pi_config_dir ?? ''}
            />
            <label htmlFor="runtime-sessions">会话历史目录</label>
            <textarea
              id="runtime-sessions"
              rows={2}
              readOnly
              value={data?.directories.sessions_dir ?? ''}
            />
            <label htmlFor="runtime-extensions">扩展绝对路径（可选，每行一个）</label>
            <textarea
              id="runtime-extensions"
              rows={3}
              value={extensions}
              onChange={(event) => setExtensions(event.target.value)}
            />
          </details>
        </fieldset>
        <p className="field-hint">
          保存后检查本地配置。远端是否接受密钥和模型，以实际请求结果为准。
        </p>
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setApiKey('');
              onClose();
            }}
          >
            取消
          </button>
          <button className="primary" disabled={busy || !data}>
            {busy ? '检查中…' : '保存并检查'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
