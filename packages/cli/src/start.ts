import type { Config } from "@react-native-community/cli-types";
import * as logger from "@rnx-kit/console";
import {
  isDevServerRunning,
  loadMetroConfig,
  makeReporter,
  makeTerminal,
  startServer,
} from "@rnx-kit/metro-service";
import type { ReportableEvent, Reporter, RunServerOptions } from "metro";
import type { Middleware } from "metro-config";
import type Server from "metro/src/Server";
import * as path from "node:path";
import { requireExternal } from "./helpers/externals";
import { customizeMetroConfig } from "./helpers/metro-config";
import { asNumber, asResolvedPath, asStringArray } from "./helpers/parsers";
import { makeHelp } from "./serve/help";
import { attachKeyHandlers } from "./serve/keyboard";
import { getKitServerConfig } from "./serve/kit-config";
import type {
  DevServerMiddleware,
  DevServerMiddleware6,
  StartCommandArgs,
} from "./serve/types";

function hasAttachToServerFunction(
  devServer: DevServerMiddleware | DevServerMiddleware6
): devServer is DevServerMiddleware6 {
  return "attachToServer" in devServer;
}

export async function rnxStart(
  _argv: string[],
  ctx: Config,
  args: StartCommandArgs
): Promise<void> {
  const serverConfig = getKitServerConfig(args);

  const { createDevServerMiddleware, indexPageMiddleware } = requireExternal(
    "@react-native-community/cli-server-api",
    ctx.root,
    ctx.reactNativePath
  );

  // interactive mode requires raw access to stdin
  let interactive = args.interactive;
  if (interactive) {
    interactive = process.stdin.isTTY;
    if (!interactive) {
      logger.warn("Interactive mode is not supported in this environment");
    }
  }

  // load Metro configuration, applying overrides from the command line
  const metroConfig = await loadMetroConfig(ctx, {
    ...args,
    ...(serverConfig.projectRoot
      ? { projectRoot: path.resolve(serverConfig.projectRoot) }
      : undefined),
    ...(serverConfig.sourceExts
      ? { sourceExts: serverConfig.sourceExts }
      : undefined),
    ...(serverConfig.assetPlugins
      ? {
          assetPlugins: serverConfig.assetPlugins.map((p) =>
            require.resolve(p)
          ),
        }
      : undefined),
  });

  const { projectRoot, watchFolders } = metroConfig;
  const terminal = makeTerminal(projectRoot);

  // customize the metro config to include plugins, presets, etc.
  const log = (message: string): void => terminal.log(message);
  customizeMetroConfig(metroConfig, serverConfig, log);

  const { port } = metroConfig.server;
  const scheme = args.https === true ? "https" : "http";
  const serverStatus = await isDevServerRunning(
    scheme,
    args.host,
    port,
    projectRoot
  );

  switch (serverStatus) {
    case "already_running":
      logger.info(
        `A dev server is already running for this project on port ${port}. ` +
          "Exiting..."
      );
      return;
    case "in_use":
      logger.error(
        `Another process is using port ${port}. Please terminate this ` +
          "process and try again, or try another port with `--port`."
      );
      return;
  }

  // create middleware -- a collection of plugins which handle incoming
  // http(s) requests, routing them to static pages or JS functions.
  const host = args.host?.length ? args.host : "localhost";
  const devServerUrl = `${scheme}://${host}:${port}`;
  const devServer = createDevServerMiddleware({ host, port, watchFolders });

  const coreDevMiddleware = (() => {
    try {
      // https://github.com/facebook/react-native/blob/7888338295476f4d4f00733309e54b8d22318e1e/packages/community-cli-plugin/src/commands/start/runServer.js#L115
      const { createDevMiddleware } = requireExternal(
        "@react-native/dev-middleware",
        ctx.root,
        ctx.reactNativePath
      );
      return createDevMiddleware({
        projectRoot,
        serverBaseUrl: devServerUrl,
        logger,
        unstable_experiments: {
          // NOTE: Only affects the /open-debugger endpoint
          enableCustomDebuggerFrontend: true,
        },
      });
    } catch (_) {
      // Fallback to the behavior from before 0.73
      const middleware = devServer.middleware;
      middleware.use(indexPageMiddleware);

      // merge the Metro config middleware with our middleware
      const enhanceMiddleware = metroConfig.server.enhanceMiddleware;
      // @ts-expect-error We want to override `enhanceMiddleware`
      metroConfig.server.enhanceMiddleware = (
        metroMiddleware: Middleware,
        metroServer: Server
      ) => {
        return middleware.use(
          enhanceMiddleware
            ? enhanceMiddleware(metroMiddleware, metroServer)
            : metroMiddleware
        );
      };
      return undefined;
    }
  })();

  // `createDevServerMiddleware` changed its return type in
  // https://github.com/react-native-community/cli/pull/1560
  let websocketEndpoints: RunServerOptions["websocketEndpoints"] = undefined;
  let messageSocketEndpoint: DevServerMiddleware["messageSocketEndpoint"];
  let reportEventDelegate: Reporter["update"] | undefined = undefined;

  if (!hasAttachToServerFunction(devServer)) {
    websocketEndpoints = devServer.websocketEndpoints;
    messageSocketEndpoint = devServer.messageSocketEndpoint;

    // bind our `reportEvent` delegate to the Metro server
    reportEventDelegate = devServer.eventsSocketEndpoint.reportEvent;
  }

  const help = makeHelp(terminal, { hasDebugger: Boolean(coreDevMiddleware) });
  const terminalReporter = makeReporter(
    args.customLogReporterPath,
    terminal,
    projectRoot
  );

  // @ts-expect-error We want to override `reporter`
  metroConfig.reporter = {
    update(event: ReportableEvent) {
      terminalReporter.update(event);
      reportEventDelegate?.(event);
      if (interactive && event.type === "dep_graph_loading") {
        help();
      }
    },
  };

  const unstable_extraMiddleware: Middleware[] = [];
  if (coreDevMiddleware) {
    unstable_extraMiddleware.push(devServer.middleware);
    if (indexPageMiddleware) {
      unstable_extraMiddleware.push(indexPageMiddleware);
    }
    unstable_extraMiddleware.push(coreDevMiddleware.middleware);

    if (coreDevMiddleware.websocketEndpoints) {
      if (websocketEndpoints) {
        const endpoints = Object.entries(coreDevMiddleware.websocketEndpoints);
        for (const [key, value] of endpoints) {
          websocketEndpoints[key] = value;
        }
      } else {
        websocketEndpoints = coreDevMiddleware.websocketEndpoints;
      }
    }
  }

  const serverInstance = await startServer(metroConfig, {
    host: args.host,
    secure: args.https,
    secureCert: args.cert,
    secureKey: args.key,
    unstable_extraMiddleware,
    websocketEndpoints,
  });

  if (hasAttachToServerFunction(devServer)) {
    const { messageSocket, eventsSocket } =
      devServer.attachToServer(serverInstance);
    messageSocketEndpoint = messageSocket;

    // bind our `reportEvent` delegate to the Metro server
    reportEventDelegate = eventsSocket.reportEvent;
  } else {
    // `messageSocketEndpoint` should already be set at this point. But this
    // makes TypeScript happier.
    messageSocketEndpoint = devServer.messageSocketEndpoint;
  }

  // In Node 8, the default keep-alive for an HTTP connection is 5 seconds. In
  // early versions of Node 8, this was implemented in a buggy way which caused
  // some HTTP responses (like those containing large JS bundles) to be
  // terminated early.
  //
  // As a workaround, arbitrarily increase the keep-alive from 5 to 30 seconds,
  // which should be enough to send even the largest of JS bundles.
  //
  // For more info: https://github.com/nodejs/node/issues/13391
  //
  serverInstance.keepAliveTimeout = 30000;

  // in interactive mode, listen for keyboard events from stdin and bind
  // them to specific actions.
  if (interactive) {
    attachKeyHandlers(serverInstance, {
      devServerUrl,
      help,
      messageSocketEndpoint,
      metroTerminal: {
        terminal,
        reporter: terminalReporter,
      },
      reactNativePath: ctx.reactNativePath,
    });
  }
}

export const rnxStartCommand = {
  name: "rnx-start",
  func: rnxStart,
  description: "Start a React Native development server",
  options: [
    {
      name: "--port <number>",
      description:
        "Host port to use when listening for incoming server requests",
      parse: asNumber,
      default: 8081,
    },
    {
      name: "--host <string>",
      description:
        "Host name or address to bind when listening for incoming server requests; when not specified, requests from all addresses are accepted",
      default: "",
    },
    {
      name: "--project-root <path>",
      description:
        "Path to the root of your react-native project; the bundle server uses this path to resolve all web requests",
      parse: asResolvedPath,
    },
    {
      name: "--watch-folders <paths>",
      description:
        "Additional folders which will be added to the watched files list, comma-separated; by default, Metro watches all project files",
      parse: (val: string) => asStringArray(val).map(asResolvedPath),
    },
    {
      name: "--asset-plugins <list>",
      description:
        "Additional asset plugins to be used by Metro's Babel transformer; comma-separated list containing plugin module names or absolute paths to plugin packages",
      parse: asStringArray,
    },
    {
      name: "--source-exts <list>",
      description:
        "Additional source file extensions to include when generating bundles; comma-separated list, excluding the leading dot",
      parse: asStringArray,
    },
    {
      name: "--max-workers <number>",
      description:
        "Specifies the maximum number of parallel worker threads to use for transforming files; defaults to the number of cores available on your machine",
      parse: asNumber,
    },
    {
      name: "--reset-cache",
      description: "Reset the Metro cache",
    },
    {
      name: "--custom-log-reporter-path <string>",
      description:
        "Path to a JavaScript file which exports a Metro 'TerminalReporter' function; replaces the default reporter that writes all messages to the Metro console",
    },
    {
      name: "--https",
      description:
        "Use a secure (https) web server; when not specified, an insecure (http) web server is used",
    },
    {
      name: "--key <path>",
      description:
        "Path to a custom SSL private key file to use for secure (https) communication",
    },
    {
      name: "--cert <path>",
      description:
        "Path to a custom SSL certificate file to use for secure (https) communication",
    },
    {
      name: "--config <string>",
      description: "Path to the Metro configuration file",
      parse: asResolvedPath,
    },
    {
      name: "--no-interactive",
      description: "Disables interactive mode",
    },
    {
      name: "--id <string>",
      description:
        "Specify which bundle configuration to use if server configuration is missing",
    },
  ],
};
