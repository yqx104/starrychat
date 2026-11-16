import { getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';
import { assertConfigComplete, readPrivateConfig, writePrivateConfigs } from './files.ts';
import type { ModelSelection } from './selection.ts';
import { ConfigurationError } from '../model/errors.ts';
import { readSystemPrompt, validateSystemPrompt, type SystemPromptConfiguration } from './prompt.ts';

type Json = Record<string, unknown>;
export interface ModelConfiguration extends ModelSelection {
  base_url?: string; api?: string; api_key?: string; clear_api_key?: boolean;
  system_prompt?: SystemPromptConfiguration;
}
export interface ModelOption { id: string; name: string; api: string; base_url: string; builtin: boolean }
export interface ProviderOption {
  id: string; base_url: string; api: string; has_api_key: boolean; has_oauth: boolean; models: ModelOption[];
}
export const configurableApis = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];

function object(value: unknown, file: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigurationError(`请检查 pi-config/${file} 的配置结构`);
  return value as Json;
}
function providerId(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value) || ['constructor', 'prototype'].includes(value)) {
    throw new ConfigurationError('Provider 必须以字母或数字开头，只能包含字母、数字、点、下划线和连字符');
  }
}
function baseUrl(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.length > 2048) throw new Error();
    return value.replace(/\/+$/, '');
  } catch { throw new ConfigurationError('接口地址必须为 HTTP(S) Base URL，不能包含用户名、密码、查询参数或片段'); }
}
function string(value: unknown, file: string): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new ConfigurationError(`请检查 pi-config/${file} 的配置结构`);
  return value;
}
function load(directory: string) {
  assertConfigComplete(directory);
  const auth = readPrivateConfig(directory, 'auth.json');
  const models = readPrivateConfig(directory, 'models.json');
  const providers = models.providers === undefined ? {} : object(models.providers, 'models.json');
  for (const [id, value] of Object.entries(providers)) {
    providerId(id);
    const provider = object(value, 'models.json');
    if (provider.models !== undefined && (!Array.isArray(provider.models) || provider.models.some(value => {
      const model = object(value, 'models.json');
      return typeof model.id !== 'string' || !model.id;
    }))) throw new ConfigurationError('请检查 pi-config/models.json 的 models 数组');
  }
  for (const value of Object.values(auth)) object(value, 'auth.json');
  return { auth, models, providers };
}

// Metadata only: never resolve credentials or copy auth/header values into HTTP responses.
export function readModelOptions(directory: string): ProviderOption[] {
  const { auth, providers } = load(directory);
  return [...new Set([...getBuiltinProviders(), ...Object.keys(providers), ...Object.keys(auth)])].sort().map(id => {
    providerId(id);
    const provider = (providers[id] ?? {}) as Json;
    const credential = (auth[id] ?? {}) as Json;
    const url = baseUrl(string(provider.baseUrl, 'models.json'));
    const api = string(provider.api, 'models.json');
    const entries = new Map<string, ModelOption>(getBuiltinModels(id as BuiltinProvider).map(model => [model.id,
      { id: model.id, name: model.name, api: model.api, base_url: url || model.baseUrl, builtin: true }]));
    for (const value of (provider.models ?? []) as Json[]) {
      const modelId = value.id as string;
      const builtin = entries.get(modelId);
      entries.set(modelId, { id: modelId, name: string(value.name, 'models.json') || modelId,
        api: string(value.api, 'models.json') || api || builtin?.api || '',
        base_url: baseUrl(string(value.baseUrl, 'models.json')) || url || builtin?.base_url || '', builtin: false });
    }
    return { id, base_url: url, api, models: [...entries.values()],
      has_api_key: credential.type === 'api_key' && !!credential.key || !!provider.apiKey,
      has_oauth: credential.type === 'oauth' };
  });
}

export function saveModelConfiguration(directory: string, input: ModelConfiguration) {
  const promptFiles: Record<string, string | null> = {};
  if (input.system_prompt !== undefined) {
    const prompt = validateSystemPrompt(input.system_prompt);
    readSystemPrompt(directory);
    promptFiles['SYSTEM.md'] = prompt.mode === 'replace' ? prompt.text : null;
    // A prompt-only PATCH must leave model selection and credentials untouched.
    if (!Object.keys(input).some(key => key !== 'system_prompt')) {
      writePrivateConfigs(directory, promptFiles); return;
    }
  }
  const settings = readPrivateConfig(directory, 'settings.json');
  const { auth, models, providers } = load(directory);
  if (!input.provider || !input.model) {
    if (input.base_url || input.api || input.api_key || input.clear_api_key) throw new ConfigurationError('请先填写 Provider 和 Model');
    delete settings.defaultProvider; delete settings.defaultModel;
    writePrivateConfigs(directory, { 'settings.json': settings, ...promptFiles }); return;
  }
  const id = input.provider; providerId(id);
  if (input.model.length > 256 || /[\x00-\x1f\x7f]/.test(input.model)) throw new ConfigurationError('Model ID 无效');
  const provider = { ...(providers[id] as Json | undefined) };
  const definitions = ((provider.models ?? []) as Json[]).map(value => ({ ...value }));
  let definition = definitions.find(value => value.id === input.model);
  const builtin = getBuiltinModels(id as BuiltinProvider).find(value => value.id === input.model);
  if (input.api && !configurableApis.includes(input.api) && input.api !== builtin?.api && input.api !== definition?.api && input.api !== provider.api) {
    throw new ConfigurationError('不支持所选接口类型');
  }
  if (builtin && !definition && input.api && input.api !== builtin.api) throw new ConfigurationError('内置模型的接口类型自动确定；其他协议请使用自定义 Provider');
  if (input.base_url !== undefined) {
    const url = baseUrl(input.base_url);
    if (url) provider.baseUrl = url; else delete provider.baseUrl;
    if (definition) delete definition.baseUrl;
  }
  if (input.api !== undefined && (!builtin || definition)) {
    if (input.api) provider.api = input.api; else delete provider.api;
    if (definition) delete definition.api;
  }
  if (!builtin && !definition && (input.base_url !== undefined || input.api !== undefined)) {
    if (!provider.baseUrl || !provider.api) throw new ConfigurationError('自定义模型需要填写接口地址和接口类型');
    definition = { id: input.model }; definitions.push(definition);
  }
  if (definition && ((!definition.baseUrl && !provider.baseUrl && !builtin?.baseUrl) || (!definition.api && !provider.api && !builtin?.api))) {
    throw new ConfigurationError('自定义模型需要填写接口地址和接口类型');
  }
  if (definitions.length) provider.models = definitions;
  const credential = auth[id] as Json | undefined;
  const key = input.api_key?.trim();
  if (input.clear_api_key && key) throw new ConfigurationError('替换 API Key 和清除 API Key 不能同时操作');
  if (key) {
    if (key.length > 16384 || /[\x00-\x1f\x7f]/.test(key)) throw new ConfigurationError('API Key 格式无效');
    // The form accepts a literal, never a Pi environment/shell expression.
    const literal = key.replaceAll('$', () => '$$').replace(/^!/, '$$!');
    auth[id] = { type: 'api_key', key: literal };
  } else if (input.clear_api_key) {
    if (credential?.type === 'api_key') delete auth[id];
  } else if (!credential && typeof provider.apiKey === 'string' && provider.apiKey) {
    auth[id] = { type: 'api_key', key: provider.apiKey };
  }
  delete provider.apiKey;
  const hasOverrides = provider.models || provider.baseUrl || provider.headers || provider.compat || provider.modelOverrides || provider.oauth || provider.authHeader !== undefined;
  if (hasOverrides) providers[id] = provider; else delete providers[id];
  models.providers = providers;
  settings.defaultProvider = id; settings.defaultModel = input.model;
  writePrivateConfigs(directory, { 'auth.json': auth, 'models.json': models, 'settings.json': settings, ...promptFiles });
}
