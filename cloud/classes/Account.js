const { Parse } = global;
const Base = require('./Base');
const { clearSessionsFromUser } = require('../utils');

class Account extends Base {
  constructor() {
    super(Account.prototype.constructor.name);
  }

  static async beforeSave(request) {
    const { object, master: isMaster } = request;
    await super.beforeSave(request);
    if (!isMaster) {
      const { user } = request;
      const accountACL = object.isNew() ? new Parse.ACL() : object.getACL();
      accountACL.setPublicReadAccess(true);
      accountACL.setPublicWriteAccess(false);
      accountACL.setReadAccess(user, true);
      accountACL.setWriteAccess(user, true);
      object.setACL(accountACL);
    }
  }

  static async afterDelete(request) {
    const account = request.object;
    const user = account.get('user');
    await clearSessionsFromUser(user);
    user.destroy({ useMasterKey: true });
  }
}

module.exports = Account;
