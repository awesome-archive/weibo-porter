import { Service } from './Service';
import axios from 'axios';
import { RedisUtil } from '../utils/Redis';
import { until, By } from 'selenium-webdriver';
import * as fs from 'fs';
import { DownloaderUtil } from '../utils/Downloader';


export class BilibiliService extends Service {
  /**
   * 开始监听用户动态
   * @param uid 要监听的用户ID
   * @param newDynamicHandler 当监听到新动态时的处理器
   */
  public startListenDynamic(uid: number, newDynamicHandler: DynamicHandler) {
    setInterval(async () => {
      if (await this.checkLock()) {
        return;
      }
      await this.createLock();
      this.printLog('正在检查动态');
      await this.getDynamics(uid, newDynamicHandler);
      this.printLog('动态完毕');
      await this.removeLock();
    }, 10 * 1000)
  }

  public async getDynamics(uid: number, newDynamicHandler: DynamicHandler): Promise<void> {
    let response = await axios.get(`https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?visitor_uid=927290&host_uid=${uid}`, {
      transformResponse: (data) => {
        return JSON.parse((data as string).replace(/"dynamic_id":(\d+?),/g, (content) => {
          return content.replace(/([\d]+)/g, (id) => `"${id}"`);
        }));
      },
      responseType: 'json',
    });
    let responseData: IBilibiliDynamicResponse = response.data;
    let dynamicList: ILocalDynamic[] = [];

    if (responseData.code === 0) {
      // 将动态push进列表
      for (const card of responseData.data.cards.reverse()) {
        // console.log(card)
        const dynamic: IBilibiliDynamic = JSON.parse(card.card);
        // 判断动态类型 并处理为本地动态类型
        if ('content' in dynamic.item) {
          dynamicList.push({
            type: DynamicTypes.Text,
            id: `text_${card.desc.dynamic_id}`,
            dynamicId: card.desc.dynamic_id,
            title: '',
            content: dynamic.item.content,
            imgs: [],
            timestamp: dynamic.item.timestamp,
            hasOrigin: 'origin' in dynamic,
          })
        } else if ('description' in dynamic.item) {
          dynamicList.push({
            type: DynamicTypes.Article,
            id: `article_${card.desc.dynamic_id}`,
            dynamicId: card.desc.dynamic_id,
            title: dynamic.item.title,
            content: dynamic.item.description,
            imgs: dynamic.item.pictures ? dynamic.item.pictures.map((pic) => ({ src: pic.img_src })) : [],
            timestamp: dynamic.item.upload_time,
            hasOrigin: false,
          })
        }
      }

      const redisClient = await RedisUtil.getRedis();

      // 分析是否有新动态
      for (const dynamic of dynamicList) {
        const redisSetKey: string = `bBo_${uid}`;
        const idCount = await redisClient.sismember(redisSetKey, dynamic.id);
        if (idCount === 0) {
          this.printLog(`新动态：${dynamic.content}`);
          await newDynamicHandler(dynamic);
          await redisClient.sadd(redisSetKey, dynamic.id);
          await this.getDriver().sleep(1000);
        }
      }
      redisClient.close();
    }
  }

  public async takeScreenshot(dynamic: ILocalDynamic): Promise<string> {
    const driver = this.getDriver();
    await driver.get(`https://t.bilibili.com/${dynamic.dynamicId}`);
    await driver.wait(until.elementLocated(By.className('main-content')));
    await driver.sleep(3 * 1000);

    await driver.executeScript(`
      var forwAreaList = document.getElementsByClassName('forw-area');
      if (forwAreaList.length > 0) {
        forwAreaList[0].remove();
      }
    `);
    await driver.sleep(500);
    const imgData = await driver.findElement(By.className('detail-card')).takeScreenshot(true);
    const savePath = `${DownloaderUtil.getTempPath()}/screenshot_${dynamic.id}.png`;
    await fs.writeFileSync(savePath, imgData, 'base64');
    return savePath;
  }

  protected async checkLock(): Promise<boolean> {
    const redisClient = await RedisUtil.getRedis();
    const lockCount = await redisClient.exists('dynamic_lock');
    redisClient.close();
    return lockCount === 1;
  }

  protected async createLock() {
    const redisClient = await RedisUtil.getRedis();
    redisClient.set('dynamic_lock', '1');
    redisClient.close();
  }

  protected async removeLock() {
    const redisClient = await RedisUtil.getRedis();
    redisClient.del('dynamic_lock');
    redisClient.close();
  }

  protected printLog(log: string | number) {
    console.log(`[${(new Date()).toLocaleString('cn')}] ${log}`);
  }
}

export interface IBilibiliDynamicResponse {
  code: number;
  msg: string;
  message: string;
  data: {
    has_more: number;
    cards: {
      desc: {
        uid: number;
        dynamic_id: string;
      },
      card: string;
    }[]
  }
}

export interface IBilibiliDynamic {
  item: {
    id?: number;
    rp_id?: number;
    title?: string;
    description?: string;
    content?: string;
    pictures?: {
      img_src: string;
    }[],
    upload_time: number;
    timestamp: number;
  },
  origin?: string;
}

export enum DynamicTypes {
  Article,
  Text,
}

export interface ILocalDynamic {
  type: DynamicTypes;
  id: string;
  dynamicId: string;
  title: string;
  content: string;
  imgs: {
    src: string;
  }[];
  timestamp: number;
  hasOrigin: boolean;
}

type DynamicHandler = (dynamic: ILocalDynamic) => Promise<any>;
