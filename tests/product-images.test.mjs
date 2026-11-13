import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {readProductImageIndex} from '../lib/product-images.mjs';
import {readProductImage,uploadProductImage} from '../lib/product-information-files.mjs';
import {readProductInformation,previewProductInformation} from '../lib/product-information.mjs';

function image(f,id,sku,stamp='2026-11-12T01:00:00Z') {
    f.sqlite.prepare('INSERT INTO product_profile_files(id,sku,object_key,sha256,name,content_type,size,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id,sku,'private/'+id,'digest-'+id,'test-'+id+'.png','image/png',100,'supply-1','测试供应链',stamp);
}

test('运营只读SKU图片，不获得成本参考、历史、上传权限或修改库存',async()=>{
    const f=fixture();try{
        image(f,'img-a','BAG-A');
        const stock=f.sqlite.prepare('SELECT * FROM inventory_balances').all();
        for(const who of [f.users.indonesia,f.users.malaysia,f.users.finance,f.users.admin,f.users.supply]){
            assert.deepEqual(await readProductImageIndex(f.db,who),{images:[{sku:'BAG-A',id:'img-a'}]});
            assert.equal((await readProductImage(f.db,who,'img-a')).sku,'BAG-A');
        }
        await assert.rejects(readProductInformation(f.db,f.users.indonesia),e=>e.status===403);
        await assert.rejects(previewProductInformation(f.db,f.users.indonesia,{}),e=>e.status===403);
        await assert.rejects(uploadProductImage(f.db,{},f.users.indonesia,{sku:'BAG-A',file:null}),e=>e.status===403);
        assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances').all(),stock);
        assert.equal(f.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,0);
    }finally{f.sqlite.close();}
});

test('图片按完整SKU精确匹配，缺图不借用其他颜色，最新主图选择稳定',async()=>{
    const f=fixture();try{
        for(const sku of ['BAG-A-BLACK','BAG-A-BLUE','bag-a'])f.sqlite.prepare('INSERT INTO sku_settings(sku,name,updated_at) VALUES(?,?,?)').run(sku,sku,'2026-01-01');
        image(f,'img-old','BAG-A','2026-11-11T01:00:00Z');image(f,'img-2','BAG-A');image(f,'img-3','BAG-A');image(f,'img-black','BAG-A-BLACK');image(f,'img-lower','bag-a');
        const {images}=await readProductImageIndex(f.db,f.users.indonesia);
        assert.deepEqual(images,[{sku:'BAG-A',id:'img-3'},{sku:'BAG-A-BLACK',id:'img-black'},{sku:'bag-a',id:'img-lower'}]);
        await assert.rejects(readProductImage(f.db,f.users.indonesia,'not-a-file'),e=>e.status===404);
    }finally{f.sqlite.close();}
});

test('图片读取拒绝匿名、未授权角色、停用和权限已变更账号',async()=>{
    const f=fixture();try{
        image(f,'img-a','BAG-A');
        for(const who of [null,f.users.sales,{...f.users.admin,role:'工厂'},{...f.users.admin,role:'达人BD'},{...f.users.admin,role:'拍摄剪辑'}, {...f.users.admin,role:'运营'}]){
            await assert.rejects(readProductImageIndex(f.db,who),e=>e.status===403);
            await assert.rejects(readProductImage(f.db,who,'img-a'),e=>e.status===403);
        }
        f.sqlite.prepare('UPDATE users SET active=0 WHERE id=?').run(f.users.indonesia.id);
        await assert.rejects(readProductImageIndex(f.db,f.users.indonesia),e=>e.status===403);
        await assert.rejects(readProductImage(f.db,f.users.indonesia,'img-a'),e=>e.status===403);
    }finally{f.sqlite.close();}
});
