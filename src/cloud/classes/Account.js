/* @flow */
const Base = require('./Base');
const UserService = require('../services/UserService');

class Account extends Base {
  constructor() {
    super(Account.prototype.constructor.name);
  }

  static async beforeSave(request: Object) {
    return request.object;
  }

  static async afterDelete(request: Object): Promise<any> {
    const account = request.object;
    const user = account.get('user');
    await UserService.clearUserSessions(user);
    user.destroy({ useMasterKey: true });
  }
}

module.exports = Account;