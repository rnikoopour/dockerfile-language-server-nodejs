/* --------------------------------------------------------------------------------------------
 * Copyright (c) Remy Suen. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	createConnection, InitializeParams, InitializeResult, ClientCapabilities,
	TextDocumentPositionParams, TextDocumentSyncKind, TextDocument, TextEdit, Hover,
	CompletionItem, CodeActionParams, Command, ExecuteCommandParams,
	DocumentSymbolParams, SymbolInformation, SignatureHelp,
	DocumentFormattingParams, DocumentRangeFormattingParams, DocumentOnTypeFormattingParams, DocumentHighlight,
	RenameParams, WorkspaceEdit, Location,
	DidChangeTextDocumentParams, DidOpenTextDocumentParams, DidCloseTextDocumentParams, TextDocumentContentChangeEvent,
	DidChangeConfigurationNotification, ConfigurationItem, DocumentLinkParams, DocumentLink, MarkupKind, VersionedTextDocumentIdentifier, TextDocumentEdit
} from 'vscode-languageserver';
import { ValidatorSettings, ValidationSeverity } from 'dockerfile-utils';
import { CommandIds, DockerfileLanguageServiceFactory } from 'dockerfile-language-service';

/**
 * The settings to use for the validator if the client doesn't support
 * workspace/configuration requests.
 */
let validatorSettings: ValidatorSettings | null = null;

/**
 * The validator settings that correspond to an individual file retrieved via
 * the workspace/configuration request.
 */
let validatorConfigurations: Map<string, Thenable<ValidatorConfiguration>> = new Map();

let connection = createConnection();
let service = DockerfileLanguageServiceFactory.createLanguageService();
service.setLogger({
	log(message): void {
		connection.console.log(message);
	}
});

/**
 * Whether the client supports the workspace/applyEdit request.
 */
let applyEditSupport: boolean = false;

/**
 * Whether the client supports the workspace/configuration request.
 */
let configurationSupport: boolean = false;

let documentChangesSupport: boolean = false;

let documents: { [ uri: string ]: TextDocument } = {};

function supportsSnippets(capabilities: ClientCapabilities): boolean {
	return capabilities.textDocument
		&& capabilities.textDocument.completion
		&& capabilities.textDocument.completion.completionItem
		&& capabilities.textDocument.completion.completionItem.snippetSupport;
}

/**
 * Gets the MarkupKind[] that the client supports for the
 * documentation field of a CompletionItem.
 * 
 * @return the supported MarkupKind[], may be null or undefined
 */
function getCompletionItemDocumentationFormat(capabilities: ClientCapabilities): MarkupKind[] | null | undefined {
	return capabilities.textDocument
		&& capabilities.textDocument.completion
		&& capabilities.textDocument.completion.completionItem
		&& capabilities.textDocument.completion.completionItem.documentationFormat;
}

function getHoverContentFormat(capabilities: ClientCapabilities): MarkupKind[] {
	return capabilities.textDocument
		&& capabilities.textDocument.hover
		&& capabilities.textDocument.hover.contentFormat;
}

function setServiceCapabilities(capabilities: ClientCapabilities): void {
	service.setCapabilities({
		completion: {
			completionItem: {
				documentationFormat: getCompletionItemDocumentationFormat(capabilities),
				snippetSupport: supportsSnippets(capabilities)
			}
		},
		hover: {
			contentFormat: getHoverContentFormat(capabilities)
		}
	});
}

connection.onInitialized(() => {
	if (configurationSupport) {
		// listen for notification changes if the client supports workspace/configuration
		connection.client.register(DidChangeConfigurationNotification.type);
	}
});

connection.onInitialize((params: InitializeParams): InitializeResult => {
	setServiceCapabilities(params.capabilities);
	applyEditSupport = params.capabilities.workspace && params.capabilities.workspace.applyEdit === true;
	documentChangesSupport = params.capabilities.workspace && params.capabilities.workspace.workspaceEdit && params.capabilities.workspace.workspaceEdit.documentChanges === true;
	configurationSupport = params.capabilities.workspace && params.capabilities.workspace.configuration === true;
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			codeActionProvider: applyEditSupport,
			completionProvider: {
				resolveProvider: true,
				triggerCharacters: [
					'=',
					' ',
					'$',
					'-',
				]
			},
			executeCommandProvider: applyEditSupport ? {
				commands: [
					CommandIds.LOWERCASE,
					CommandIds.UPPERCASE,
					CommandIds.EXTRA_ARGUMENT,
					CommandIds.DIRECTIVE_TO_BACKSLASH,
					CommandIds.DIRECTIVE_TO_BACKTICK,
					CommandIds.FLAG_TO_CHOWN,
					CommandIds.FLAG_TO_COPY_FROM,
					CommandIds.FLAG_TO_HEALTHCHECK_INTERVAL,
					CommandIds.FLAG_TO_HEALTHCHECK_RETRIES,
					CommandIds.FLAG_TO_HEALTHCHECK_START_PERIOD,
					CommandIds.FLAG_TO_HEALTHCHECK_TIMEOUT,
					CommandIds.CONVERT_TO_AS,
					CommandIds.REMOVE_EMPTY_CONTINUATION_LINE
				]
			} : undefined,
			documentFormattingProvider: true,
			documentRangeFormattingProvider: true,
			documentOnTypeFormattingProvider: {
				firstTriggerCharacter: '\\',
				moreTriggerCharacter: [ '`' ]
			},
			hoverProvider: true,
			documentSymbolProvider: true,
			documentHighlightProvider: true,
			renameProvider: true,
			definitionProvider: true,
			signatureHelpProvider: {
				triggerCharacters: [
					'-',
					'[',
					',',
					' ',
					'='
				]
			},
			documentLinkProvider: {
				resolveProvider: false
			}
		}
	}
});

function validateTextDocument(textDocument: TextDocument): void {
	if (configurationSupport) {
		getConfiguration(textDocument.uri).then((config: ValidatorConfiguration) => {
			let maintainer = ValidationSeverity.WARNING;
			let directiveCasing = ValidationSeverity.WARNING;
			let emptyContinuationLine = ValidationSeverity.WARNING;
			let instructionCasing = ValidationSeverity.WARNING;
			let instructionCmdMultiple = ValidationSeverity.WARNING;
			let instructionEntrypointMultiple = ValidationSeverity.WARNING;
			let instructionHealthcheckMultiple = ValidationSeverity.WARNING;
			let instructionJSONInSingleQuotes = ValidationSeverity.WARNING;
			if (config) {
				maintainer = getSeverity(config.deprecatedMaintainer);
				directiveCasing = getSeverity(config.directiveCasing);
				emptyContinuationLine = getSeverity(config.emptyContinuationLine);
				instructionCasing = getSeverity(config.instructionCasing);
				instructionCmdMultiple = getSeverity(config.instructionCmdMultiple);
				instructionEntrypointMultiple = getSeverity(config.instructionEntrypointMultiple);
				instructionHealthcheckMultiple = getSeverity(config.instructionHealthcheckMultiple);
				instructionJSONInSingleQuotes = getSeverity(config.instructionHealthcheckMultiple);
			}
			const fileSettings = {
				deprecatedMaintainer: maintainer,
				directiveCasing: directiveCasing,
				emptyContinuationLine: emptyContinuationLine,
				instructionCasing: instructionCasing,
				instructionCmdMultiple: instructionCmdMultiple,
				instructionEntrypointMultiple: instructionEntrypointMultiple,
				instructionHealthcheckMultiple: instructionHealthcheckMultiple,
				instructionJSONInSingleQuotes: instructionJSONInSingleQuotes
			};
			const diagnostics = service.validate(textDocument.getText(), fileSettings);
			connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
		});
	} else {
		const diagnostics = service.validate(textDocument.getText(), validatorSettings);
		connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
	}
}

interface ValidatorConfiguration {
	deprecatedMaintainer?: string,
	directiveCasing?: string,
	emptyContinuationLine?: string,
	instructionCasing?: string,
	instructionCmdMultiple?: string,
	instructionEntrypointMultiple?: string,
	instructionHealthcheckMultiple?: string,
	instructionJSONInSingleQuotes?: string
}

interface Settings {
	docker: {
		languageserver: {
			diagnostics?: ValidatorConfiguration
		}
	}
}

function getSeverity(severity: string | undefined): ValidationSeverity | null {
	switch (severity) {
		case "ignore":
			return ValidationSeverity.IGNORE;
		case "warning":
			return ValidationSeverity.WARNING;
		case "error":
			return ValidationSeverity.ERROR;
	}
	return null;
}

/**
 * Gets the validation configuration that pertains to the specified resource.
 * 
 * @param resource the interested resource
 * @return the configuration to use to validate the interested resource
 */
function getConfiguration(resource: string): Thenable<ValidatorConfiguration> {
	let result = validatorConfigurations.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({ section: "docker.languageserver.diagnostics", scopeUri: resource });
		validatorConfigurations.set(resource, result);
	}
	return result;
}

// listen for notifications when the client's configuration has changed
connection.onNotification(DidChangeConfigurationNotification.type, () => {
	refreshConfigurations();
});

/**
 * Wipes and reloads the internal cache of validator configurations.
 */
function refreshConfigurations() {
	// store all the URIs that need to be refreshed
	const settingsRequest: ConfigurationItem[] = [];
	for (let uri in documents) {
		settingsRequest.push({ section: "docker.languageserver.diagnostics", scopeUri: uri });
	}
	// clear the cache
	validatorConfigurations.clear();

	// ask the workspace for the configurations
	connection.workspace.getConfiguration(settingsRequest).then((values: ValidatorConfiguration[]) => {
		const toRevalidate: string[] = [];
		for (let i = 0; i < values.length; i++) {
			const resource = settingsRequest[i].scopeUri;
			// a value might have been stored already, use it instead and ignore this one if so
			if (values[i] && !validatorConfigurations.has(resource)) {
				validatorConfigurations.set(resource, Promise.resolve(values[i]));
				toRevalidate.push(resource);
			}
		}

		for (const resource of toRevalidate) {
			validateTextDocument(documents[resource]);
		}
	});
}

connection.onDidChangeConfiguration((change) => {
	if (configurationSupport) {
		refreshConfigurations();
	} else {
		let settings = <Settings>change.settings;
		let maintainer = ValidationSeverity.WARNING;
		let directiveCasing = ValidationSeverity.WARNING;
		let emptyContinuationLine = ValidationSeverity.WARNING;
		let instructionCasing = ValidationSeverity.WARNING;
		let instructionCmdMultiple = ValidationSeverity.WARNING;
		let instructionEntrypointMultiple = ValidationSeverity.WARNING;
		let instructionHealthcheckMultiple = ValidationSeverity.WARNING;
		if (settings.docker && settings.docker.languageserver && settings.docker.languageserver.diagnostics) {
			maintainer = getSeverity(settings.docker.languageserver.diagnostics.deprecatedMaintainer);
			directiveCasing = getSeverity(settings.docker.languageserver.diagnostics.directiveCasing);
			emptyContinuationLine = getSeverity(settings.docker.languageserver.diagnostics.emptyContinuationLine);
			instructionCasing = getSeverity(settings.docker.languageserver.diagnostics.instructionCasing);
			instructionCmdMultiple = getSeverity(settings.docker.languageserver.diagnostics.instructionCmdMultiple);
			instructionEntrypointMultiple = getSeverity(settings.docker.languageserver.diagnostics.instructionEntrypointMultiple);
			instructionHealthcheckMultiple = getSeverity(settings.docker.languageserver.diagnostics.instructionHealthcheckMultiple);
		}
		validatorSettings = {
			deprecatedMaintainer: maintainer,
			directiveCasing: directiveCasing,
			emptyContinuationLine: emptyContinuationLine,
			instructionCasing: instructionCasing,
			instructionCmdMultiple: instructionCmdMultiple,
			instructionEntrypointMultiple: instructionEntrypointMultiple,
			instructionHealthcheckMultiple: instructionHealthcheckMultiple
		};
		// validate all the documents again
		Object.keys(documents).forEach((key) => {
			validateTextDocument(documents[key]);
		});
	}
});

connection.onCompletion((textDocumentPosition: TextDocumentPositionParams): CompletionItem[] | PromiseLike<CompletionItem[]> => {
	let document = documents[textDocumentPosition.textDocument.uri];
	if (document) {
		return service.computeCompletionItems(document.getText(), textDocumentPosition.position);
	}
	return null;
});

connection.onSignatureHelp((textDocumentPosition: TextDocumentPositionParams): SignatureHelp => {
	let document = documents[textDocumentPosition.textDocument.uri];
	if (document !== null) {
		return service.computeSignatureHelp(document.getText(), textDocumentPosition.position);
	}
	return {
		signatures: [],
		activeSignature: null,
		activeParameter: null,
	};
});

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	return service.resolveCompletionItem(item);
});

connection.onHover((textDocumentPosition: TextDocumentPositionParams): Hover => {
	let document = documents[textDocumentPosition.textDocument.uri];
	if (document !== null) {
		return service.computeHover(document.getText(), textDocumentPosition.position);
	}
	return null;
});

connection.onDocumentHighlight((textDocumentPosition: TextDocumentPositionParams): DocumentHighlight[] => {
	let document = documents[textDocumentPosition.textDocument.uri];
	if (document) {
		return service.computeHighlightRanges(document.getText(), textDocumentPosition.position);
	}
	return [];
});

connection.onCodeAction((codeActionParams: CodeActionParams): Command[] => {
	if (applyEditSupport && codeActionParams.context.diagnostics.length > 0) {
		return service.computeCodeActions(codeActionParams.textDocument, codeActionParams.range, codeActionParams.context);
	}
	return [];
});

connection.onExecuteCommand((params: ExecuteCommandParams): void => {
	if (applyEditSupport) {
		let uri: string = params.arguments[0];
		let document = documents[uri];
		if (document) {
			let edits = service.computeCommandEdits(document.getText(), params.command, params.arguments);
			if (edits) {
				if (documentChangesSupport) {
					let identifier = VersionedTextDocumentIdentifier.create(uri, document.version);
					connection.workspace.applyEdit({
						documentChanges: [
							TextDocumentEdit.create(identifier, edits)
						]
					});
				} else {
					connection.workspace.applyEdit({
						changes: {
							[ uri ]: edits
						}
					});
				}
			}
		}
	}
});

connection.onDefinition((textDocumentPosition: TextDocumentPositionParams): Location => {
	let uri = textDocumentPosition.textDocument.uri;
	let document = documents[uri];
	if (document) {
		return service.computeDefinition(textDocumentPosition.textDocument, document.getText(), textDocumentPosition.position);
	}
	return null;
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit => {
	let document = documents[params.textDocument.uri];
	if (document) {
		let edits = service.computeRename(params.textDocument, document.getText(), params.position, params.newName);
		return {
			changes: {
				[ params.textDocument.uri ]: edits
			}
		};
	}
	return null;
});

connection.onDocumentSymbol((documentSymbolParams: DocumentSymbolParams): SymbolInformation[] => {
	let uri = documentSymbolParams.textDocument.uri;
	let document = documents[uri];
	if (document) {
		return service.computeSymbols(documentSymbolParams.textDocument, document.getText());
	}
	return [];
});

connection.onDocumentFormatting((documentFormattingParams: DocumentFormattingParams): TextEdit[] => {
	let document = documents[documentFormattingParams.textDocument.uri];
	if (document) {
		return service.format(document.getText(), documentFormattingParams.options);
	}
	return [];
});

connection.onDocumentRangeFormatting((rangeFormattingParams: DocumentRangeFormattingParams): TextEdit[] => {
	let document = documents[rangeFormattingParams.textDocument.uri];
	if (document) {
		return service.formatRange(document.getText(), rangeFormattingParams.range, rangeFormattingParams.options);
	}
	return [];
});

connection.onDocumentOnTypeFormatting((onTypeFormattingParams: DocumentOnTypeFormattingParams): TextEdit[] => {
	const document = documents[onTypeFormattingParams.textDocument.uri];
	if (document) {
		return service.formatOnType(document.getText(), onTypeFormattingParams.position, onTypeFormattingParams.ch, onTypeFormattingParams.options);
	}
	return [];
});

connection.onDocumentLinks((documentLinkParams: DocumentLinkParams): DocumentLink[] => {
	let document = documents[documentLinkParams.textDocument.uri];
	if (document) {
		return service.computeLinks(document.getText());
	}
	return null;
});

connection.onDidOpenTextDocument((didOpenTextDocumentParams: DidOpenTextDocumentParams): void => {
	let document = TextDocument.create(didOpenTextDocumentParams.textDocument.uri, didOpenTextDocumentParams.textDocument.languageId, didOpenTextDocumentParams.textDocument.version, didOpenTextDocumentParams.textDocument.text);
	documents[didOpenTextDocumentParams.textDocument.uri] = document;
	validateTextDocument(document);
});

connection.onDidChangeTextDocument((didChangeTextDocumentParams: DidChangeTextDocumentParams): void => {
	let document = documents[didChangeTextDocumentParams.textDocument.uri];
	let buffer = document.getText();
	let content = buffer;
	let changes = didChangeTextDocumentParams.contentChanges;
	for (let i = 0; i < changes.length; i++) {
		let offset = document.offsetAt(changes[i].range.start);
		let end = null;
		if (changes[i].range.end) {
			end = document.offsetAt(changes[i].range.end);
		} else {
			end = offset + changes[i].rangeLength;
		}
		buffer = buffer.substring(0, offset) + changes[i].text + buffer.substring(end);
	}
	document = TextDocument.create(didChangeTextDocumentParams.textDocument.uri, document.languageId, didChangeTextDocumentParams.textDocument.version, buffer);
	documents[didChangeTextDocumentParams.textDocument.uri] = document;
	if (content !== buffer) {
		validateTextDocument(document);
	}
});

connection.onDidCloseTextDocument((didCloseTextDocumentParams: DidCloseTextDocumentParams): void => {
	validatorConfigurations.delete(didCloseTextDocumentParams.textDocument.uri);
	connection.sendDiagnostics({ uri: didCloseTextDocumentParams.textDocument.uri, diagnostics: [] });
	delete documents[didCloseTextDocumentParams.textDocument.uri];
});

// setup complete, start listening for a client connection
connection.listen();
