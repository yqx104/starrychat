import { isAbsolute, join } from 'node:path';
import { ConfigurationError, errorMessage, type AgentContext } from '@starrychat/adaptor-contracts';
import type { PiSettings } from '../model/types.ts';
import { readModelSelection, type ModelSelection } from './selection.ts';
import { readModelOptions, saveModelConfiguration, type ModelConfiguration, type ProviderOption } from './models.ts';
import { readSystemPrompt, validateSystemPrompt, type SystemPromptConfiguration } from './prompt.ts';

export function piDirectories(context: AgentContext) {
  return { cwd: context.cwd, pi_config_dir: join(context.root, 'pi-config'), sessions_dir: join(context.root, 'sessions') };
}

export function piSettings(value: unknown): Partial<PiSettings> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ConfigurationError('Pi 运行配置必须为对象');
  const settings = value as Partial<PiSettings>;
  if (settings.pi_config_dir !== undefined && typeof settings.pi_config_dir !== 'string' ||
      settings.extensions !== undefined && (!Array.isArray(settings.extensions) || settings.extensions.some(path => typeof path !== 'string' || !isAbsolute(path)))) {
    throw new ConfigurationError('Pi 目录或扩展配置无效');
  }
  return settings;
}

export function runtimeSettings(value: unknown): ModelConfiguration & Pick<PiSettings, 'extensions'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigurationError('config 必须为对象');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['provider', 'model', 'base_url', 'api', 'api_key', 'clear_api_key', 'system_prompt', 'extensions'].includes(key))) {
    throw new ConfigurationError('只接受模型、接口、API Key、系统提示词和扩展配置；目录由 adaptor 管理');
  }
  const settings: ModelConfiguration & Pick<PiSettings, 'extensions'> = {};
  if (input.provider !== undefined || input.model !== undefined) {
    if (typeof input.provider !== 'string' || typeof input.model !== 'string' || !!input.provider.trim() !== !!input.model.trim()) {
      throw new ConfigurationError('provider 和 model 需要同时填写');
    }
    settings.provider = input.provider.trim(); settings.model = input.model.trim();
  }
  for (const key of ['base_url', 'api', 'api_key'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') throw new ConfigurationError('接口和密钥配置必须为字符串');
      settings[key] = input[key].trim();
    }
  }
  if (input.clear_api_key !== undefined) {
    if (typeof input.clear_api_key !== 'boolean') throw new ConfigurationError('clear_api_key 必须为布尔值');
    settings.clear_api_key = input.clear_api_key;
  }
  if (!settings.provider && (settings.base_url || settings.api || settings.api_key || settings.clear_api_key)) {
    throw new ConfigurationError('请先填写 Provider 和 Model');
  }
  if (input.system_prompt !== undefined) settings.system_prompt = validateSystemPrompt(input.system_prompt);
  if (input.extensions !== undefined) {
    if (!Array.isArray(input.extensions) || input.extensions.length > 20 || input.extensions.some(path => typeof path !== 'string' || !isAbsolute(path))) {
      throw new ConfigurationError('扩展必须是绝对路径数组，最多 20 项');
    }
    settings.extensions = input.extensions;
  }
  return settings;
}

export function readRuntimeConfig(context: AgentContext, stored: unknown) {
  const directories = piDirectories(context);
  const settings = piSettings(stored);
  let selection: ModelSelection = {}; let modelOptions: ProviderOption[] = []; let configurationIssue: string | null = null;
  try { selection = readModelSelection(directories.pi_config_dir); modelOptions = readModelOptions(directories.pi_config_dir); }
  catch (error) { configurationIssue = errorMessage(error); }
  let systemPrompt: SystemPromptConfiguration = { mode: 'default', text: '' };
  try { systemPrompt = readSystemPrompt(directories.pi_config_dir); }
  catch (error) { configurationIssue ??= errorMessage(error); }
  return { config: { extensions: settings.extensions ?? [], ...selection, system_prompt: systemPrompt },
    model_options: modelOptions, configuration_issue: configurationIssue, directories };
}

export function saveRuntimeConfig(context: AgentContext, input: unknown, stored: unknown): PiSettings {
  const { pi_config_dir } = piDirectories(context);
  const previous = piSettings(stored);
  const { extensions, ...modelConfig } = runtimeSettings(input);
  try { saveModelConfiguration(pi_config_dir, modelConfig); }
  catch (error) { throw error instanceof ConfigurationError ? error : new ConfigurationError('无法保存 pi-config 配置，请检查目录权限'); }
  return { pi_config_dir, extensions: extensions ?? previous.extensions ?? [] };
}
