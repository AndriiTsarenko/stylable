/* tslint:disable:no-unused-expression */
import * as express from 'express';
import * as http from 'http';
import { join } from 'path';
import * as puppeteer from 'puppeteer';
import { promisify } from 'util';
import * as webpack from 'webpack';
const rimrafCallback = require('rimraf');
const { launch } = require('puppeteer');
const runExpress = require('express');
const runWebpack = require('webpack');

export interface Options {
  projectDir: string;
  port: number;
  puppeteerOptions: puppeteer.LaunchOptions;
  throwOnBuildError: boolean;
}

const rimraf = promisify(rimrafCallback);

export class ProjectRunner {
  // tslint:disable-next-line:ban-types
  public static mochaSetup(runnerOptions: Options, before: Function, afterEach: Function, after: Function) {
    const projectRunner = new this(runnerOptions);

    before('bundle and serve project', async () => {
      await projectRunner.bundle();
      await projectRunner.serve();
    });

    afterEach('cleanup open pages', async () => {
      await projectRunner.closeAllPages();
    });

    after('destroy runner', async () => {
      await projectRunner.destroy();
    });

    return projectRunner;
  }
  public projectDir: string;
  public outputDir: string;
  public webpackConfig: webpack.Configuration;
  public port: number;
  public puppeteerOptions: puppeteer.LaunchOptions;
  public pages: puppeteer.Page[];
  public stats: webpack.Stats | null;
  public throwOnBuildError: boolean;
  public serverUrl: string;
  public server!: http.Server | null;
  public browser!: puppeteer.Browser | null;
  constructor({
    projectDir,
    port = 3000,
    puppeteerOptions = {},
    throwOnBuildError = true
  }: Options) {
    this.projectDir = projectDir;
    this.outputDir = join(this.projectDir, 'dist');
    this.webpackConfig = this.loadTestConfig();
    this.port = port;
    this.serverUrl = `http://localhost:${this.port}`;
    this.puppeteerOptions = puppeteerOptions;
    this.pages = [];
    this.stats = null;
    this.throwOnBuildError = throwOnBuildError;
  }
  public loadTestConfig() {
    return require(join(this.projectDir, 'webpack.config.js'));
  }
  public async bundle() {
    const webpackConfig = this.webpackConfig;
    if (webpackConfig.output && webpackConfig.output.path) {
      throw new Error('Test project should not specify output.path option');
    } else {
      webpackConfig.output = {
        ...webpackConfig.output,
        path: this.outputDir
      };
    }
    const compiler = runWebpack(webpackConfig);
    compiler.run = promisify(compiler.run);
    this.stats = await compiler.run() as any as webpack.Stats;
    if (this.throwOnBuildError && (this.stats as any).compilation.errors.length) {
      throw new Error((this.stats as any).errors);
    }
  }

  public async serve() {
    if (this.server) {
      throw new Error('project server is already running in port ' + this.port);
    }
    const app = runExpress();
    app.use(
      express.static(this.outputDir, { cacheControl: false, etag: false })
    );
    return new Promise((res, rej) => {
      this.server = app.listen(this.port, (err: Error) => {
        if (err) {
          return rej(err);
        }
        res();
      });
      (this.server as any).close = promisify(this.server!.close);
    });
  }

  public async openInBrowser() {
    if (!this.browser) {
      this.browser = await launch(this.puppeteerOptions);
    }
    const page = await this.browser!.newPage();
    this.pages.push(page);

    await page.setCacheEnabled(false);
    const responses: puppeteer.Response[] = [];
    page.on('response', response => {
      responses.push(response);
    });
    await page.goto(this.serverUrl, { waitUntil: 'networkidle0' });
    return { page, responses };
  }

  public getBuildWarningMessages() {
    return (this.stats as any).compilation.warnings.slice();
  }

  public async closeAllPages() {
    for (const page of this.pages) {
      await page.close();
    }
    this.pages.length = 0;
  }

  public async destroy() {
    this.browser && (await this.browser.close());
    this.browser = null;
    this.server && (await this.server.close());
    this.server = null;
    await rimraf(this.outputDir);
  }
}