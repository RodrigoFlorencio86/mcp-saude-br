import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/** Erro quando ferramenta não encontra resultados */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Erro de fonte de dados externa indisponível */
export class DataSourceError extends Error {
  constructor(
    message: string,
    public readonly source: string,
    public readonly retryable: boolean = true
  ) {
    super(message);
    this.name = 'DataSourceError';
  }
}

/** Erro de validação de parâmetros */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Converte qualquer erro em resposta de ferramenta MCP com isError: true
 * (Tool execution errors, não protocol errors)
 */
export function toToolError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  let message: string;

  if (error instanceof ValidationError) {
    message = `Parâmetro inválido: ${error.message}`;
  } else if (error instanceof NotFoundError) {
    message = `Não encontrado: ${error.message}`;
  } else if (error instanceof DataSourceError) {
    message = `Fonte de dados "${error.source}" indisponível: ${error.message}`;
    if (error.retryable) {
      message += '. Tente novamente em alguns instantes.';
    }
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = 'Erro interno desconhecido';
  }

  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/**
 * Cria um McpError de protocolo para tool não encontrada
 */
export function unknownToolError(name: string): McpError {
  return new McpError(ErrorCode.MethodNotFound, `Ferramenta desconhecida: ${name}`);
}
