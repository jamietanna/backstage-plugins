/***/
/**
 * Node.js library for the renovate-wrapper plugin.
 *
 * @packageDocumentation
 */

import is from '@sindresorhus/is';
import { getPlatformEnvs } from './platforms';
import { RouterOptions } from '../service/types';
import { extractReport, getCacheEnvs } from './utils';
import {
  EntityWithAnnotations,
  getTargetRepo,
  getTaskID,
  RenovateReport,
  RenovateWrapper,
  TargetRepo,
} from '@secustor/backstage-plugin-renovate-common';
import { Config } from '@backstage/config';
import { LoggerService, SchedulerService } from '@backstage/backend-plugin-api';
import { getRuntime, getScheduleDefinition } from '../config';
import { DatabaseHandler } from '../service/databaseHandler';
import { RunOptions } from './types';
import { isError, NotFoundError } from '@backstage/errors';

export class RenovateRunner {
  private scheduler: SchedulerService;
  private rootConfig: Config;
  private databaseHandler: DatabaseHandler;
  private pluginConfig: Config;
  private logger: LoggerService;
  private runtimes: Map<string, RenovateWrapper>;

  constructor(
    databaseHandler: DatabaseHandler,
    rootConfig: Config,
    pluginConfig: Config,
    logger: LoggerService,
    runtimes: Map<string, RenovateWrapper>,
    scheduler: SchedulerService,
  ) {
    this.databaseHandler = databaseHandler;
    this.rootConfig = rootConfig;
    this.pluginConfig = pluginConfig;
    this.logger = logger;
    this.runtimes = runtimes;
    this.scheduler = scheduler;
  }

  static async from(options: RouterOptions): Promise<RenovateRunner> {
    const {
      databaseHandler,
      rootConfig,
      pluginConfig,
      runtimes,
      logger,
      scheduler,
    } = options;

    return new RenovateRunner(
      databaseHandler,
      rootConfig,
      pluginConfig,
      logger,
      runtimes,
      scheduler,
    );
  }

  private async renovate(
    id: string,
    target: TargetRepo,
    { logger }: RunOptions,
  ): Promise<RenovateReport> {
    const runtime = getRuntime(this.pluginConfig);
    const wrapperRuntime = this.runtimes.get(runtime);
    if (is.nullOrUndefined(wrapperRuntime)) {
      throw new Error(`Unknown runtime type '${runtime}'`);
    }

    const env: Record<string, string> = {
      // setup logging
      LOG_FORMAT: 'json',
      LOG_LEVEL: 'debug',
      LOG_CONTEXT: id,
      RENOVATE_REPORT_TYPE: 'logging',
      // setup platform specifics
      ...getPlatformEnvs(target, {
        logger,
        rootConfig: this.rootConfig,
      }),
      ...getCacheEnvs(this.rootConfig, logger),
    };

    // read out renovate.config and write out to json file for consumption by Renovate
    // we are reading it at this place to allow dynamic configuration changes
    const renovateConfig = this.pluginConfig.getOptional('config') ?? {};
    const runtimeConfig =
      this.pluginConfig.getOptionalConfig(`runtime.${runtime}`) ?? null;

    const promise = wrapperRuntime.run({
      env,
      renovateConfig,
      runtimeConfig,
    });

    return await promise.then(result => {
      return extractReport({
        logger,
        logStream: result.stdout,
      });
    });
  }

  async run(id: string, target: TargetRepo): Promise<void> {
    const logger = this.logger.child({ taskID: id, ...target });
    try {
      logger.info('Renovate run starting');
      const report = await this.renovate(id, target, { logger });
      await this.databaseHandler.addReport({
        taskID: id,
        report,
        target,
        logger,
      });
      logger.info('Renovate run successfully finished');
    } catch (e) {
      logger.error('Renovate failed', isError(e) ? e : {});
    }
  }

  async schedule(
    target: string | EntityWithAnnotations | TargetRepo,
  ): Promise<void> {
    const id = getTaskID(target);
    const childLogger = this.logger.child({ taskID: id });
    const targetRepo = getTargetRepo(target);

    // try to trigger existing schedule and if this fails, start a run.
    try {
      childLogger.debug('Triggering task');
      await this.scheduler.triggerTask(id);
      return;
    } catch (e) {
      childLogger.debug('Scheduling new task');
      // expected error handle else rethrow
      if (isError(e) && e.name === NotFoundError.name) {
        this.scheduler.scheduleTask({
          id,
          fn: () => this.run(id, targetRepo),
          ...getScheduleDefinition(this.pluginConfig, 'renovation'),
        });
        return;
      }
      throw e;
    }
  }
}
