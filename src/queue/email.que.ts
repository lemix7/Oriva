import {Queue} from 'bullmq'
import connection from '../config/redis.ts'

const emailQueue = new Queue('emailQueue' , {connection})

export default emailQueue